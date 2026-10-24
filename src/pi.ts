import { invariant } from './errors.js';
import type { Json, MessageInput, ModelInput, ModelProfile, PreparedContext, UsageObservation } from './types.js';

export type PiModelInfo = { id: string; provider: string; api: string; contextWindow: number; maxTokens: number };
type PiUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
type Text = { type: 'text'; text: string };
type Call = { type: 'toolCall'; id: string; name: string; arguments: { [key: string]: Json }; argumentsError?: string; namespace?: string };
export type PiResponse = { role: 'assistant'; content: ({ type: string; text?: string } | Call)[]; stopReason: string; usage: Pick<PiUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>; errorMessage?: string };
type PiMessage =
  | { role: 'user'; content: string; timestamp: number }
  | { role: 'assistant'; content: (Text | Call)[]; api: string; provider: string; model: string; usage: PiUsage; stopReason: 'stop' | 'toolUse'; timestamp: number }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: Text[]; isError: boolean; timestamp: number };
const zeroUsage = (): PiUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function piModelProfile(model: PiModelInfo, countTokens: ModelProfile['countTokens'], counterRevision = 'v1'): ModelProfile {
  return { id: `${model.provider}/${model.id}/${counterRevision}`, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, countTokens };
}
/** Rebuilds portable public history; provider thinking/signatures are deliberately absent. */
export function toPiContext<TTool>(input: ModelInput, model: PiModelInfo, tools: TTool[]): { systemPrompt: string; messages: PiMessage[]; tools: TTool[] } {
  if ('modelId' in input) {
    invariant(typeof input.modelId === 'string' && input.modelId.startsWith(`${model.provider}/${model.id}/`), 'Prepare a new context for the selected Pi model before switching.');
    invariant('budget' in input && input.budget && typeof input.budget === 'object' && 'contextWindow' in input.budget
      && input.budget.contextWindow === model.contextWindow, 'Pi capacity changed; prepare the context again.');
  }
  invariant(JSON.stringify(tools) === JSON.stringify(input.tools), 'Pass the same tool definitions used in the budget calculation.');
  const messages = input.messages.map((message): PiMessage => {
    const timestamp = Date.parse(message.createdAt);
    if (message.role === 'user') return { role: 'user', content: message.text, timestamp };
    if (message.role === 'tool') return { role: 'toolResult', toolCallId: message.callId, toolName: message.name, content: [{ type: 'text', text: message.text }], isError: message.isError, timestamp };
    const content: (Text | Call)[] = message.text ? [{ type: 'text', text: message.text }] : [];
    for (const call of message.toolCalls ?? []) content.push({ type: 'toolCall', ...structuredClone(call) });
    return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp };
  });
  return { systemPrompt: input.systemPrompt, tools: structuredClone(tools), messages };
}
export function fromPiAssistant(response: PiResponse, id?: string): MessageInput {
  invariant(['stop', 'toolUse'].includes(response.stopReason), 'Only a completed Pi response may enter the replayable session.');
  invariant(response.content.every((part) => ['text', 'thinking', 'toolCall'].includes(part.type)), 'The first core supports text and tools; unsupported public content must not be silently dropped.');
  const calls = response.content.filter((part): part is Call => part.type === 'toolCall');
  invariant((calls.length > 0) === (response.stopReason === 'toolUse'), 'Pi tool stop reason and calls disagree.');
  invariant(calls.every((call) => !call.argumentsError), 'Invalid streamed tool arguments must not become executable calls.');
  invariant(calls.every((call) => call.namespace === undefined), 'Map namespaced provider tools to explicit portable names in the host before recording.');
  const text = response.content.filter((part) => part.type === 'text').map((part) => 'text' in part ? part.text ?? '' : '').join('');
  return {
    role: 'assistant', text,
    ...(id ? { id } : {}),
    ...(calls.length ? { toolCalls: calls.map(({ id: callId, name, arguments: args }) => ({ id: callId, name, arguments: structuredClone(args) })) } : {}),
  };
}
/** Pi reports cache reads/writes separately: include both in total input-window usage. */
export function piUsage(context: PreparedContext, response: PiResponse): UsageObservation {
  return { basis: structuredClone(context.usageBasis), inputTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite, outputTokens: response.usage.output };
}
