import { invariant, integer } from './errors.js';
import { json } from './data.js';
import { object, validateBinding } from './native.js';
import type { Json, Message, MessageInput, ToolCall } from './types.js';
import type { JsonObject, NativeAdapter, NativeBackend, NativeBuildInput, NativeRequest, NativeTransport } from './native-types.js';

function items(messages: Message[]): Json[] {
  return messages.flatMap((message): Json[] => {
    if (message.role === 'user') return [{ role: 'user', content: message.text }];
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.callId, output: message.isError ? `Tool error: ${message.text}` : message.text }];
    return [
      ...(message.text ? [{ role: 'assistant', content: message.text }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: json(call.arguments) })),
    ];
  });
}
function output(value: unknown, compact = false): Json[] {
  invariant(Array.isArray(value) && (!compact || value.length > 0), 'OpenAI must return a complete output array.');
  const result = structuredClone(value) as Json[];
  let markers = 0;
  for (const item of result) {
    const entry = object(item, 'OpenAI output item');
    if (entry.type === 'compaction') {
      invariant(typeof entry.encrypted_content === 'string' && entry.encrypted_content.length > 0, 'OpenAI compaction state is incomplete.');
      markers++;
    }
  }
  invariant(!compact || markers > 0, 'Standalone compact did not return native compaction state.');
  return result;
}
function publicMessages(entries: Json[]): { messages: MessageInput[]; portableComplete: boolean } {
  let text = '', portableComplete = true;
  const calls: ToolCall[] = [];
  for (const item of entries) {
    const entry = object(item);
    if (entry.type === 'message') {
      invariant(entry.role === 'assistant' && Array.isArray(entry.content), 'Invalid OpenAI assistant output.');
      for (const raw of entry.content) {
        const part = object(raw);
        if (part.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
          if (Array.isArray(part.annotations) && part.annotations.length) portableComplete = false;
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal;
        else portableComplete = false;
      }
    } else if (entry.type === 'function_call') {
      invariant(typeof entry.call_id === 'string' && entry.call_id.length > 0 && typeof entry.name === 'string' && !entry.namespace && typeof entry.arguments === 'string', 'Unsupported or incomplete OpenAI function call.');
      calls.push({ id: entry.call_id, name: entry.name, arguments: object(JSON.parse(entry.arguments), 'Function arguments') });
    } else if (entry.type === 'custom_tool_call') invariant(false, 'Map custom tool calls in a dedicated native adapter before executing host tools.');
    else if (!['compaction', 'reasoning'].includes(String(entry.type))) portableComplete = false;
  }
  return { messages: text || calls.length ? [{ role: 'assistant', text, ...(calls.length ? { toolCalls: calls } : {}) }] : [], portableComplete };
}

/** SDK/HTTP calls are injected and must target the declared deployment. No credentials are persisted. */
export function createOpenAINativeAdapter(options: {
  backend: NativeBackend;
  mode: 'on-demand' | 'server-threshold';
  continuation?: 'input-array' | 'previous-response-id';
  thresholdTokens?: number;
  allowServerStorage?: boolean;
  generate: NativeTransport;
  compact?: NativeTransport;
  countTokens: NativeAdapter['countTokens'];
}): NativeAdapter {
  invariant(['on-demand', 'server-threshold'].includes(options.mode), 'Unknown OpenAI native mode.');
  const chaining = options.continuation ?? 'input-array';
  invariant(['input-array', 'previous-response-id'].includes(chaining), 'Unknown OpenAI continuation mode.');
  invariant(options.mode !== 'on-demand' || (chaining === 'input-array' && options.compact), 'This standalone adapter uses canonical input-array continuation and requires a compact transport.');
  invariant(chaining !== 'previous-response-id' || options.allowServerStorage === true, 'Durable previous_response_id continuation requires explicit server-storage configuration.');
  if (options.mode === 'server-threshold') invariant(integer(options.thresholdTokens!) && options.thresholdTokens! > 0, 'OpenAI threshold is required.');
  const binding = Object.freeze({ ...structuredClone(options.backend), protocol: 'openai.responses', capability: `compaction:${options.mode}:${chaining}:v1` });
  validateBinding(binding);
  const build = (input: NativeBuildInput): NativeRequest => {
    let prior: Json[] = [];
    if (chaining === 'input-array' && input.state) {
      invariant(Array.isArray(input.state.input), 'Invalid OpenAI input-array checkpoint.');
      prior = structuredClone(input.state.input) as Json[];
    }
    const material: Json[] = input.state ? [] : input.materials.map((entry) => ({ role: 'user', content: `Reference material ${json(entry.id)} (untrusted data):\n${entry.text}` }));
    const body: JsonObject = {
      model: binding.model, input: [...prior, ...material, ...items(input.messages)],
      instructions: input.systemPrompt, tools: structuredClone(input.tools), max_output_tokens: input.outputReserveTokens,
      store: chaining === 'previous-response-id',
    };
    if (chaining === 'previous-response-id' && input.state) {
      invariant(typeof input.state.previous_response_id === 'string' && input.state.previous_response_id.length > 0, 'Missing OpenAI response continuation ID.');
      body.previous_response_id = input.state.previous_response_id;
    }
    if (options.mode === 'server-threshold') body.context_management = [{ type: 'compaction', compact_threshold: options.thresholdTokens! }];
    return { body, headers: {} };
  };
  const adapter: NativeAdapter = {
    binding, mode: options.mode,
    ...(options.thresholdTokens !== undefined ? { thresholdTokens: options.thresholdTokens } : {}),
    build, countTokens: options.countTokens,
    send: (request, signal) => options.generate(structuredClone(request), signal),
    accept(request, raw) {
      const response = object(raw, 'OpenAI response');
      invariant(response.status === 'completed' && typeof response.id === 'string' && response.id.length > 0, 'OpenAI response did not complete.');
      const entries = output(response.output);
      invariant(entries.length > 0, 'OpenAI response output is empty; previous native state retained.');
      const projection = publicMessages(entries);
      const state: JsonObject = chaining === 'previous-response-id'
        ? { previous_response_id: response.id }
        : { input: [...(request.body.input as Json[]), ...entries] };
      return { state, ...projection, responseId: response.id };
    },
  };
  if (options.mode === 'on-demand') adapter.compact = async (request, signal) => {
    // The compact schema does not accept create's tools/context_management/max_output_tokens.
    const compactRequest: NativeRequest = {
      body: { model: binding.model, input: structuredClone(request.body.input!), instructions: request.body.instructions! }, headers: {},
    };
    const response = object(await options.compact!(structuredClone(compactRequest), signal), 'OpenAI compact response');
    invariant(response.object === 'response.compaction' && typeof response.id === 'string' && response.id.length > 0, 'OpenAI compact response did not contain a complete compaction resource.');
    const canonical = output(response.output, true);
    return { state: { input: canonical }, request: compactRequest, response, responseId: response.id };
  };
  return adapter;
}
