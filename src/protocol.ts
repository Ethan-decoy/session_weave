import { invariant } from './errors.js';
import { json, safeId } from './data.js';
import type { Message } from './types.js';

/** Returns ends of complete protocol groups. A parallel tool batch is one indivisible group. */
export function protocol(messages: Message[]): { ends: number[]; pending: string[] } {
  const ids = new Set<string>(), calls = new Set<string>(), pending = new Map<string, string>();
  const ends: number[] = [];
  for (const [index, message] of messages.entries()) {
    safeId(message.id);
    invariant(!ids.has(message.id) && message.sequence === index + 1, 'Message IDs and sequence must be unique and contiguous.');
    ids.add(message.id);
    invariant(typeof message.text === 'string' && Number.isFinite(Date.parse(message.createdAt)), 'Message text and valid timestamp are required.');
    const allowed = ['id', 'sequence', 'createdAt', 'role', 'text', ...(message.role === 'assistant' ? ['toolCalls'] : message.role === 'tool' ? ['callId', 'name', 'isError'] : [])];
    invariant(Object.keys(message).every((key) => allowed.includes(key)), 'Only portable public message fields are accepted.');
    if (message.role === 'tool') {
      invariant(pending.get(message.callId) === message.name && typeof message.isError === 'boolean', 'Tool result must match an outstanding call and its name.');
      pending.delete(message.callId);
    } else {
      invariant(message.role === 'user' || message.role === 'assistant', 'Unknown message role.');
      invariant(pending.size === 0, 'Complete all tool results before another user or assistant message.');
      invariant(index !== 0 || message.role === 'user', 'A session starts with a user message.');
      if (message.role === 'assistant') {
        invariant(message.toolCalls === undefined || Array.isArray(message.toolCalls), 'Invalid tool calls.');
        for (const call of message.toolCalls ?? []) {
          invariant(Object.keys(call).every((key) => ['id', 'name', 'arguments'].includes(key)), 'Tool calls require portable ID, name and JSON arguments only.');
          invariant(typeof call.id === 'string' && call.id.length > 0 && typeof call.name === 'string' && call.name.length > 0, 'Tool call ID and name are required.');
          invariant(!calls.has(call.id), 'Tool call IDs cannot be reused in a session.');
          invariant(call.arguments && !Array.isArray(call.arguments) && typeof call.arguments === 'object', 'Tool arguments must be a JSON object.');
          json(call.arguments);
          calls.add(call.id);
          pending.set(call.id, call.name);
        }
      }
    }
    if (pending.size === 0) ends.push(index + 1);
  }
  return { ends, pending: [...pending.keys()] };
}
