import { randomUUID } from 'node:crypto';
import { invariant, integer } from './errors.js';
import { json, safeId } from './data.js';
import { protocol } from './protocol.js';
import { validateNativeCheckpoint } from './native.js';
import { assertMemoryProvenance, memoryDigest, memoryPublicationBase } from './memory-provenance.js';
import type { Checkpoint, Handoff, Message, Mutation, SessionState, WorkingMemoryCandidate, WorkingMemoryCheckpoint } from './types.js';

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
  return { version: 1, sessionId, revision: 0, messages: [], checkpoints: [], usage: [], nativeCheckpoints: [], workingMemoryCheckpoints: [], appendLog: [] };
}

export function createWorkingMemoryCheckpoint(state: SessionState, candidate: WorkingMemoryCandidate): WorkingMemoryCheckpoint {
  invariant(Object.keys(candidate).every((key) => ['complete', 'sourceRevision', 'sourceThroughId', 'activeThroughId', 'identity', 'engineState', 'projection', 'sources'].includes(key)), 'Unknown working-memory candidate fields.');
  const sourceThroughSequence = state.messages.findIndex((message) => message.id === candidate.sourceThroughId) + 1;
  const activeThroughSequence = candidate.activeThroughId === null ? 0 : state.messages.findIndex((message) => message.id === candidate.activeThroughId) + 1;
  invariant(candidate.activeThroughId === null || activeThroughSequence > 0, 'Active working-memory source does not exist.');
  return { ...structuredClone(candidate), version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    previousId: state.workingMemoryCheckpoints?.at(-1)?.id ?? null,
    sourceThroughSequence, activeThroughSequence, sourceDigest: memoryDigest(state, sourceThroughSequence) };
}

function validateWorkingMemory(checkpoint: WorkingMemoryCheckpoint, state: SessionState, ends: number[], previous?: WorkingMemoryCheckpoint): void {
  safeId(checkpoint.id);
  invariant((checkpoint.version === 1 || checkpoint.version === 2) && checkpoint.complete === true && Number.isFinite(Date.parse(checkpoint.createdAt)), 'Unsupported or incomplete working-memory checkpoint.');
  invariant(Object.keys(checkpoint).every((key) => ['version', 'id', 'createdAt', 'previousId', 'complete', 'sourceRevision', 'sourceThroughId', 'activeThroughId', 'identity', 'engineState', 'projection', 'sources', 'sourceThroughSequence', 'activeThroughSequence', 'sourceDigest',
    ...(checkpoint.version === 2 ? ['publishedFromRevision', 'publishedMessageCount', 'publishedRawDigest', 'provenance'] : [])].includes(key)), 'Unknown working-memory checkpoint fields.');
  invariant(integer(checkpoint.sourceRevision) && checkpoint.sourceRevision > 0 && checkpoint.sourceRevision < state.revision
    && checkpoint.sourceRevision > (previous?.sourceRevision ?? -1) && checkpoint.previousId === (previous?.id ?? null), 'Invalid working-memory revision or checkpoint chain.');
  invariant(!previous || checkpoint.sourceRevision > memoryPublicationBase(previous), 'Candidate source predates its working-memory predecessor publication.');
  invariant(integer(checkpoint.sourceThroughSequence) && ends.includes(checkpoint.sourceThroughSequence)
    && state.messages[checkpoint.sourceThroughSequence - 1]?.id === checkpoint.sourceThroughId, 'Working-memory input must end at a complete raw protocol group.');
  invariant(integer(checkpoint.activeThroughSequence) && checkpoint.activeThroughSequence <= checkpoint.sourceThroughSequence
    && (checkpoint.activeThroughSequence === 0 ? checkpoint.activeThroughId === null
      : ends.includes(checkpoint.activeThroughSequence) && state.messages[checkpoint.activeThroughSequence - 1]?.id === checkpoint.activeThroughId), 'Active working-memory coverage must be a closed prefix of its input.');
  invariant(checkpoint.sourceDigest === memoryDigest(state, checkpoint.sourceThroughSequence), 'Working-memory source does not match the immutable raw prefix.');
  invariant(checkpoint.identity && Object.keys(checkpoint.identity).length === 3
    && ['engine', 'codec', 'policy'].every((key) => typeof checkpoint.identity[key as keyof typeof checkpoint.identity] === 'string' && checkpoint.identity[key as keyof typeof checkpoint.identity].trim().length > 0), 'Versioned engine, codec and policy identities are required.');
  invariant(checkpoint.engineState && typeof checkpoint.engineState === 'object' && !Array.isArray(checkpoint.engineState), 'Working-memory engine state must be a complete encoded JSON object.');
  invariant(typeof checkpoint.projection === 'string' && Array.isArray(checkpoint.sources), 'Working-memory projection and raw references are required.');
  if (checkpoint.activeThroughSequence === 0) invariant(checkpoint.projection === '' && checkpoint.sources.length === 0, 'Buffered state cannot claim an active historical projection.');
  else {
    invariant(checkpoint.projection.trim().length > 0 && checkpoint.sources.length > 0, 'An active projection needs historical text and raw references.');
    const covered: { start: number; end: number }[] = [];
    for (const ref of checkpoint.sources) {
      invariant(ref && ref.sessionId === state.sessionId && Object.keys(ref).every((key) => ['sessionId', 'startId', 'endId'].includes(key)), 'Working-memory reference belongs to another source.');
      const start = state.messages.findIndex((message) => message.id === ref.startId) + 1;
      const end = state.messages.findIndex((message) => message.id === ref.endId) + 1;
      invariant(start > 0 && end >= start && end <= checkpoint.activeThroughSequence, 'Working-memory references must stay inside active raw coverage.');
      covered.push({ start, end });
    }
    let through = 0;
    for (const span of covered.sort((left, right) => left.start - right.start)) {
      invariant(span.start <= through + 1, 'Working-memory source mapping has a gap.');
      through = Math.max(through, span.end);
    }
    invariant(through === checkpoint.activeThroughSequence, 'Working-memory references must cover the represented prefix.');
  }
  if (checkpoint.version === 2) assertMemoryProvenance(checkpoint, state);
  json(checkpoint);
}

export function validateState(state: SessionState): void {
  invariant([1, 2, 3].includes(state?.version) && integer(state.revision), 'Unsupported or corrupt session state.');
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
  invariant(state.nativeCheckpoints === undefined || Array.isArray(state.nativeCheckpoints), 'Invalid native checkpoint collection.');
  const nativeIds = new Set<string>();
  let previousNative;
  const responseIds = new Set<string>();
  for (const checkpoint of state.nativeCheckpoints ?? []) {
    safeId(checkpoint.id);
    invariant(!nativeIds.has(checkpoint.id), 'Duplicate native checkpoint ID.');
    nativeIds.add(checkpoint.id);
    validateNativeCheckpoint(checkpoint, state, previousNative);
    const responseKey = json(checkpoint.binding) + ':' + checkpoint.responseId;
    invariant(!responseIds.has(responseKey), 'Native response was already committed.');
    responseIds.add(responseKey);
    previousNative = checkpoint;
  }
  invariant(state.workingMemoryCheckpoints === undefined || Array.isArray(state.workingMemoryCheckpoints), 'Invalid working-memory checkpoint collection.');
  const memories = state.workingMemoryCheckpoints ?? [];
  invariant(state.version >= 2 ? memories.length > 0 : memories.length === 0, 'Working-memory state requires session format 2 or 3; it cannot be silently omitted.');
  invariant(state.version === 3 ? memories.some((checkpoint) => checkpoint.version === 2) && Array.isArray(state.appendLog)
    : memories.every((checkpoint) => checkpoint.version === 1), 'Provenance packages require session format 3 and append receipts.');
  invariant(state.appendLog === undefined || Array.isArray(state.appendLog), 'Invalid append receipt collection.');
  let lastAppendRevision = 0, lastAppendSequence = 0;
  for (const receipt of state.appendLog ?? []) {
    invariant(Object.keys(receipt).length === 3 && integer(receipt.revision) && receipt.revision > lastAppendRevision && receipt.revision <= state.revision
      && integer(receipt.startSequence) && receipt.startSequence > lastAppendSequence && integer(receipt.endSequence)
      && receipt.endSequence >= receipt.startSequence && receipt.endSequence <= state.messages.length, 'Invalid append-only receipt.');
    lastAppendRevision = receipt.revision; lastAppendSequence = receipt.endSequence;
  }
  const memoryIds = new Set<string>();
  let previousMemory: WorkingMemoryCheckpoint | undefined;
  for (const checkpoint of memories) {
    invariant(!memoryIds.has(checkpoint.id), 'Duplicate working-memory checkpoint ID.');
    validateWorkingMemory(checkpoint, state, ends, previousMemory);
    memoryIds.add(checkpoint.id);
    previousMemory = checkpoint;
  }
  const publications = [...state.checkpoints.map((checkpoint) => checkpoint.sourceRevision + 1), ...(state.nativeCheckpoints ?? []).map((checkpoint) => checkpoint.sourceRevision + 1),
    ...memories.map((checkpoint) => memoryPublicationBase(checkpoint) + 1)];
  invariant(new Set(publications).size === publications.length && !(state.appendLog ?? []).some((receipt) => publications.includes(receipt.revision)), 'A publication cannot also be an append-only transaction.');
  json(state);
}
export function mutate(state: SessionState, mutation: Mutation): SessionState {
  if (mutation.workingMemoryCheckpoint) {
    invariant(Object.keys(mutation).every((key) => key === 'workingMemoryCheckpoint')
      && memoryPublicationBase(mutation.workingMemoryCheckpoint) === state.revision, 'Publish a complete working-memory package alone at its observed revision.');
  }
  if (mutation.nativeCheckpoint) {
    invariant(!mutation.checkpoint && !mutation.usage && mutation.nativeCheckpoint.sourceRevision === state.revision
      && mutation.nativeCheckpoint.baseSequence === state.messages.length, 'Native state requires one atomic raw/public response transaction at the observed revision.');
  }
  if (mutation.checkpoint) {
    invariant(mutation.checkpoint.sourceRevision === state.revision && !mutation.messages?.length, 'Checkpoint requires the exact observed raw revision.');
  }
  if (mutation.usage) invariant(mutation.usage.basis.revision === state.revision, 'Usage requires the exact request revision.');
  const next: SessionState = {
    ...state, revision: state.revision + 1, version: mutation.workingMemoryCheckpoint?.version === 2 || state.version === 3 ? 3 : mutation.workingMemoryCheckpoint ? 2 : state.version,
    messages: [...state.messages, ...(mutation.messages ?? [])],
    checkpoints: [...state.checkpoints, ...(mutation.checkpoint ? [mutation.checkpoint] : [])],
    usage: [...state.usage, ...(mutation.usage ? [mutation.usage] : [])],
    nativeCheckpoints: [...(state.nativeCheckpoints ?? []), ...(mutation.nativeCheckpoint ? [mutation.nativeCheckpoint] : [])],
    workingMemoryCheckpoints: [...(state.workingMemoryCheckpoints ?? []), ...(mutation.workingMemoryCheckpoint ? [mutation.workingMemoryCheckpoint] : [])],
    appendLog: [...(state.appendLog ?? []), ...(mutation.messages?.length && Object.keys(mutation).every((key) => ['messages', 'usage'].includes(key))
      ? [{ revision: state.revision + 1, startSequence: state.messages.length + 1, endSequence: state.messages.length + mutation.messages.length }] : [])],
  };
  validateState(next);
  return structuredClone(next);
}
