import { invariant, integer } from './errors.js';
import type { Checkpoint, Handoff, Message, Mutation, SessionState } from './types.js';

export function safeId(id: string): void {
  invariant(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id), 'IDs must contain 1–128 letters, digits, hyphens or underscores.');
}
export function json(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    invariant(item === null || ['string', 'boolean', 'number', 'object'].includes(typeof item), 'Values must be JSON data.');
    if (typeof item === 'number') invariant(Number.isFinite(item), 'JSON numbers must be finite.');
    if (item && typeof item === 'object') {
      invariant(!seen.has(item), 'Cyclic JSON is not supported.');
      invariant(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype, 'Only plain JSON data is supported.');
      seen.add(item);
      for (const child of Object.values(item)) visit(child);
      seen.delete(item);
    }
  };
  visit(value);
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}

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

export function validateHandoff(value: unknown, messages: Message[], sessionId: string, through: number): asserts value is Handoff {
  invariant(value && typeof value === 'object', 'Summary must be an object.');
  const state = value as Handoff;
  invariant(state.version === 1, 'Unsupported summary version.');
  invariant(Object.keys(state).every((key) => ['version', 'goals', 'constraints', 'decisions', 'completed', 'openQuestions', 'corrections'].includes(key)), 'Unknown summary fields are not portable.');
  const byId = new Map(messages.map((message) => [message.id, message.sequence]));
  let noteCount = 0;
  for (const field of ['goals', 'constraints', 'decisions', 'completed', 'openQuestions', 'corrections'] as const) {
    invariant(Array.isArray(state[field]), `Summary ${field} must be an array.`);
    for (const note of state[field]) {
      invariant(note && typeof note.text === 'string' && note.text.trim().length > 0 && Array.isArray(note.refs) && note.refs.length > 0, 'Each summary item requires text and raw references.');
      invariant(Object.keys(note).every((key) => ['text', 'refs', ...(field === 'decisions' ? ['rationale'] : [])].includes(key)), 'Unknown summary item fields.');
      if (field === 'decisions') invariant(typeof (note as { rationale?: string }).rationale === 'string' && (note as { rationale: string }).rationale.trim(), 'Decisions require a rationale.');
      for (const ref of note.refs) {
        invariant(ref && ref.sessionId === sessionId, 'Summary reference belongs to another session.');
        invariant(Object.keys(ref).every((key) => ['sessionId', 'startId', 'endId'].includes(key)), 'Unknown raw reference fields.');
        const start = byId.get(ref.startId), end = byId.get(ref.endId);
        invariant(start && end && start <= end && end <= through, 'Summary references must resolve inside the covered raw range.');
      }
      noteCount++;
    }
  }
  invariant(noteCount > 0, 'Empty handoff is not a successful summary.');
  json(value);
}

export function emptyState(sessionId: string): SessionState {
  invariant(typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.length <= 512, 'An explicit session ID is required.');
  return { version: 1, sessionId, revision: 0, messages: [], checkpoints: [], usage: [] };
}
export function validateState(state: SessionState): void {
  invariant(state?.version === 1 && integer(state.revision), 'Unsupported or corrupt session state.');
  emptyState(state.sessionId);
  invariant(Array.isArray(state.messages) && Array.isArray(state.checkpoints) && Array.isArray(state.usage), 'Session arrays are required.');
  const { ends } = protocol(state.messages);
  let previous: Checkpoint | undefined;
  const checkpointIds = new Set<string>();
  for (const checkpoint of state.checkpoints) {
    safeId(checkpoint.id);
    invariant(!checkpointIds.has(checkpoint.id), 'Duplicate checkpoint ID.');
    checkpointIds.add(checkpoint.id);
    invariant(integer(checkpoint.sourceRevision) && checkpoint.sourceRevision < state.revision, 'Invalid checkpoint revision.');
    invariant(ends.includes(checkpoint.throughSequence) && checkpoint.throughSequence >= (previous?.throughSequence ?? 1), 'Checkpoint must retain or advance coverage at a complete message group.');
    if (previous && checkpoint.throughSequence === previous.throughSequence) invariant(json(checkpoint.handoff) !== json(previous.handoff), 'Same-range checkpoint must revise the handoff.');
    invariant(state.messages[checkpoint.throughSequence - 1]?.id === checkpoint.throughId && checkpoint.previousId === (previous?.id ?? null), 'Invalid checkpoint chain or raw range.');
    validateHandoff(checkpoint.handoff, state.messages, state.sessionId, checkpoint.throughSequence);
    previous = checkpoint;
  }
  for (const usage of state.usage) {
    invariant(usage.basis.sessionId === state.sessionId && integer(usage.basis.revision) && usage.basis.revision < state.revision, 'Invalid usage revision.');
    invariant(integer(usage.inputTokens) && integer(usage.outputTokens) && integer(usage.basis.estimatedInputTokens), 'Usage counts must be nonnegative integers.');
    invariant(usage.basis.messageIds.every((id) => state.messages.some((message) => message.id === id)), 'Usage refers to missing raw messages.');
  }
  json(state);
}
export function mutate(state: SessionState, mutation: Mutation): SessionState {
  if (mutation.checkpoint) {
    invariant(mutation.checkpoint.sourceRevision === state.revision && !mutation.messages?.length, 'Checkpoint requires the exact observed raw revision.');
  }
  if (mutation.usage) invariant(mutation.usage.basis.revision === state.revision, 'Usage requires the exact request revision.');
  const next: SessionState = {
    ...state, revision: state.revision + 1,
    messages: [...state.messages, ...(mutation.messages ?? [])],
    checkpoints: [...state.checkpoints, ...(mutation.checkpoint ? [mutation.checkpoint] : [])],
    usage: [...state.usage, ...(mutation.usage ? [mutation.usage] : [])],
  };
  validateState(next);
  return structuredClone(next);
}
