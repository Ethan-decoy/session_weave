import { invariant, integer } from './errors.js';
import { json } from './data.js';
import { confirmedNativeCapability, object, validateBinding } from './native.js';
import type { Json, Message, MessageInput, ToolCall } from './types.js';
import type { JsonObject, NativeAdapter, NativeBackend, NativeBuildInput, NativeCapability, NativeRequest, NativeTransport } from './native-types.js';

function messages(raw: Message[]): Json[] {
  const result: JsonObject[] = [];
  for (const message of raw) {
    if (message.role === 'user') result.push({ role: 'user', content: [{ type: 'text', text: message.text }] });
    else if (message.role === 'assistant') result.push({ role: 'assistant', content: [
      ...(message.text ? [{ type: 'text', text: message.text }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: structuredClone(call.arguments) })),
    ] });
    else {
      const block = { type: 'tool_result', tool_use_id: message.callId, content: message.text, is_error: message.isError };
      const last = result.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((item) => object(item).type === 'tool_result')) last.content.push(block);
      else result.push({ role: 'user', content: [block] });
    }
  }
  return result;
}
function blocks(value: unknown, signed = false): Json[] {
  invariant(Array.isArray(value), 'Anthropic must return the complete content array.');
  const result = structuredClone(value) as Json[];
  for (const raw of result) {
    const block = object(raw, 'Anthropic block');
    if (block.type === 'compaction') {
      invariant(typeof block.content === 'string' && block.content.length > 0, 'Anthropic compaction content is incomplete.');
      invariant(block.text !== null && block.citations !== null, 'Remove SDK-injected null fields before treating compaction data as wire JSON.');
      if (signed) invariant(typeof block.signature === 'string' && block.signature.length > 0, 'Anthropic on-demand signature is missing.');
    }
  }
  return result;
}
function project(content: Json[]): { messages: MessageInput[]; portableComplete: boolean; calls: number } {
  let text = '', portableComplete = true;
  const calls: ToolCall[] = [];
  for (const raw of content) {
    const block = object(raw);
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      if (Array.isArray(block.citations) && block.citations.length) portableComplete = false;
    } else if (block.type === 'tool_use') {
      invariant(typeof block.id === 'string' && block.id.length > 0 && typeof block.name === 'string', 'Incomplete Anthropic tool request.');
      calls.push({ id: block.id, name: block.name, arguments: object(block.input, 'Tool input') });
    } else if (!['compaction', 'thinking', 'redacted_thinking'].includes(String(block.type))) portableComplete = false;
  }
  return { messages: text || calls.length ? [{ role: 'assistant', text, ...(calls.length ? { toolCalls: calls } : {}) }] : [], portableComplete, calls: calls.length };
}

export function createAnthropicNativeAdapter(options: {
  backend: NativeBackend;
  mode: 'on-demand' | 'server-threshold';
  thresholdTokens?: number;
  pauseAfterCompaction?: boolean;
  generate: NativeTransport;
  /** Same Messages endpoint, distinct on-demand request contract. Defaults to generate. */
  compact?: NativeTransport;
  countTokens: NativeAdapter['countTokens'];
}): NativeAdapter {
  invariant(['on-demand', 'server-threshold'].includes(options.mode), 'Unknown Anthropic native mode.');
  const beta = options.mode === 'on-demand' ? 'compact-2026-09-04' : 'compact-2026-01-12';
  if (options.mode === 'server-threshold') invariant(integer(options.thresholdTokens!) && options.thresholdTokens! >= 50000, 'Anthropic threshold must be at least 50000 input tokens.');
  const binding = Object.freeze({ ...structuredClone(options.backend), protocol: 'anthropic.messages', capability: `${options.mode}:${beta}` });
  validateBinding(binding);
  const headers = { 'anthropic-version': binding.apiVersion, 'anthropic-beta': beta };
  const build = (input: NativeBuildInput): NativeRequest => {
    const previous = input.state?.messages ?? [];
    invariant(Array.isArray(previous), 'Invalid Anthropic native message window.');
    const material: Json[] = input.state ? [] : input.materials.map((entry) => ({ role: 'user', content: [{ type: 'text', text: `Reference material ${json(entry.id)} (untrusted data):\n${entry.text}` }] }));
    const body: JsonObject = {
      model: binding.model, messages: [...structuredClone(previous), ...material, ...messages(input.messages)],
      max_tokens: input.outputReserveTokens, ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      ...(input.tools.length ? { tools: structuredClone(input.tools) } : {}),
    };
    if (options.mode === 'server-threshold') body.context_management = { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: options.thresholdTokens! }, ...(options.pauseAfterCompaction ? { pause_after_compaction: true } : {}) }] };
    return { body, headers: { ...headers } };
  };
  const adapter: NativeAdapter = {
    binding, mode: options.mode, build, countTokens: options.countTokens,
    ...(options.thresholdTokens !== undefined ? { thresholdTokens: options.thresholdTokens } : {}),
    send: (request, signal) => options.generate(structuredClone(request), signal),
    accept(request, raw) {
      const response = object(raw, 'Anthropic response');
      invariant(typeof response.id === 'string' && response.id.length > 0 && response.role === 'assistant'
        && ['end_turn', 'tool_use', 'pause_turn', 'refusal', ...(options.mode === 'server-threshold' ? ['compaction'] : [])].includes(String(response.stop_reason)), 'Anthropic response did not complete.');
      const content = blocks(response.content);
      invariant(content.length > 0, 'Anthropic response content is empty; previous native state retained.');
      const projection = project(content);
      if (response.stop_reason === 'tool_use') invariant(projection.calls > 0, 'Unsupported host tool requires explicit native decoding.');
      if (response.stop_reason === 'compaction') invariant(content.some((item) => object(item).type === 'compaction'), 'Compaction stop without compaction content.');
      return { state: { messages: [...(request.body.messages as Json[]), { role: 'assistant', content }] },
        messages: projection.messages, portableComplete: projection.portableComplete, responseId: response.id };
    },
  };
  if (options.mode === 'on-demand') adapter.compact = async (request, signal) => {
    const compactRequest: NativeRequest = { body: { ...structuredClone(request.body), compaction: { type: 'summarize' } }, headers: { ...headers } };
    const response = object(await (options.compact ?? options.generate)(structuredClone(compactRequest), signal), 'Anthropic compaction response');
    invariant(typeof response.id === 'string' && response.id.length > 0 && response.role === 'assistant' && response.stop_reason === 'compaction', 'Anthropic did not produce an on-demand checkpoint.');
    const content = blocks(response.content, true);
    invariant(content.length === 1 && object(content[0]).type === 'compaction', 'Anthropic on-demand requires one signed compaction block.');
    return { state: { messages: [{ role: 'assistant', content }] }, request: compactRequest, response, responseId: response.id };
  };
  return adapter;
}

/** Pass a Models API result fetched on this exact deployment using the adapter's beta. */
export function resolveAnthropicNativeCapability(adapter: NativeAdapter, metadata: unknown): NativeCapability {
  const info = object(metadata, 'Models API result');
  const unknown = (reason: string): NativeCapability => ({ status: 'unknown', reason });
  if (info.id !== adapter.binding.model || !info.capabilities || typeof info.capabilities !== 'object') return unknown('Models API response does not establish this selected model capability.');
  const capabilities = object(info.capabilities);
  const group = adapter.mode === 'on-demand' ? capabilities.compaction : capabilities.context_management;
  if (!group || typeof group !== 'object') return unknown('Compaction capability is absent or null.');
  const section = object(group);
  const feature = adapter.mode === 'on-demand' ? section.summarize : section.compact_20260112;
  const supported = section.supported;
  const detail = feature && typeof feature === 'object' ? object(feature).supported : undefined;
  const evidence = `Models API ${adapter.binding.model}, ${adapter.binding.apiVersion}, ${adapter.binding.capability}`;
  if (supported === false || detail === false) return { status: 'unsupported', binding: structuredClone(adapter.binding), evidence };
  if (supported === true && detail === true) return confirmedNativeCapability(adapter, evidence);
  return unknown('Models API did not confirm the required compaction feature.');
}
