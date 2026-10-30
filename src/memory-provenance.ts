import { createHash } from 'node:crypto';
import { integer, invariant } from './errors.js';
import { json } from './data.js';
import type { SessionState, WorkingMemoryCheckpoint, WorkingMemoryProvenance } from './types.js';

const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
export const memoryPublicationBase = (checkpoint: WorkingMemoryCheckpoint): number => checkpoint.version === 2 ? checkpoint.publishedFromRevision : checkpoint.sourceRevision;
export const memoryDigest = (state: SessionState, through: number): string => digest({ sessionId: state.sessionId, messages: state.messages.slice(0, through) });
function baseAt(state: SessionState, revision: number): WorkingMemoryProvenance['base'] {
  const checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.sourceRevision < revision);
  const nativeCheckpoints = (state.nativeCheckpoints ?? []).filter((checkpoint) => checkpoint.sourceRevision < revision);
  const workingMemoryCheckpoints = (state.workingMemoryCheckpoints ?? []).filter((checkpoint) => memoryPublicationBase(checkpoint) < revision);
  return { handoffId: checkpoints.at(-1)?.id ?? null, nativeId: nativeCheckpoints.at(-1)?.id ?? null,
    workingMemoryId: workingMemoryCheckpoints.at(-1)?.id ?? null, digest: digest({ checkpoints, nativeCheckpoints, workingMemoryCheckpoints }) };
}
const metadataAt = (state: SessionState, revision: number) => digest({
  usage: state.usage.filter((usage) => usage.basis.revision < revision),
  appendLog: (state.appendLog ?? []).filter((receipt) => receipt.revision <= revision),
});
function rawCountAt(state: SessionState, revision: number): number {
  let count = state.messages.length;
  for (const receipt of state.appendLog ?? []) if (receipt.revision > revision) count = Math.min(count, receipt.startSequence - 1);
  for (const checkpoint of state.nativeCheckpoints ?? []) if (checkpoint.sourceRevision >= revision) count = Math.min(count, checkpoint.baseSequence);
  return count;
}
export function captureMemoryProvenance(state: SessionState, previous: WorkingMemoryCheckpoint | null): WorkingMemoryProvenance {
  return { sourceMessageCount: state.messages.length, sourceRawDigest: memoryDigest(state, state.messages.length),
    sourceMetadataDigest: metadataAt(state, state.revision), base: baseAt(state, state.revision), previousUsedId: previous?.id ?? null, appendReceipts: [] };
}
/** Historical checks at R0 and R1; later publications do not change an older package's base. */
export function assertMemoryProvenance(checkpoint: Extract<WorkingMemoryCheckpoint, { version: 2 }>, state: SessionState): void {
  const witness = checkpoint.provenance, origin = checkpoint.sourceRevision, publish = checkpoint.publishedFromRevision;
  invariant(integer(publish) && publish >= origin && publish < state.revision, 'Invalid working-memory publication revision.');
  invariant(witness && Object.keys(witness).length === 6 && integer(witness.sourceMessageCount)
    && witness.sourceMessageCount >= checkpoint.sourceThroughSequence && integer(checkpoint.publishedMessageCount)
    && checkpoint.publishedMessageCount >= witness.sourceMessageCount && checkpoint.publishedMessageCount <= state.messages.length,
  'Invalid captured working-memory source size.');
  invariant(witness.sourceMessageCount === rawCountAt(state, origin) && checkpoint.publishedMessageCount === rawCountAt(state, publish),
    'Captured source and publication sizes disagree with historical raw transaction boundaries.');
  invariant(witness.sourceRawDigest === memoryDigest(state, witness.sourceMessageCount)
    && checkpoint.publishedRawDigest === memoryDigest(state, checkpoint.publishedMessageCount)
    && witness.sourceMetadataDigest === metadataAt(state, origin), 'Captured raw source or metadata changed.');
  invariant(json(witness.base) === json(baseAt(state, origin)) && json(witness.base) === json(baseAt(state, publish))
    && checkpoint.previousId === witness.base.workingMemoryId, 'Working-memory candidate base changed before publication.');
  if (witness.previousUsedId !== null) {
    const previous = state.workingMemoryCheckpoints?.find((item) => item.id === witness.previousUsedId);
    invariant(previous && previous.id === witness.base.workingMemoryId && json(previous.identity) === json(checkpoint.identity)
      && previous.sourceThroughSequence <= checkpoint.sourceThroughSequence, 'Invalid actual previous working memory.');
  }
  invariant(Array.isArray(witness.appendReceipts) && witness.appendReceipts.length === publish - origin, 'Append-only reuse needs one receipt per intervening revision.');
  let sequence = witness.sourceMessageCount;
  for (const [index, receipt] of witness.appendReceipts.entries()) {
    const saved = state.appendLog?.find((item) => item.revision === receipt.revision);
    invariant(saved && receipt.revision === origin + index + 1 && receipt.startSequence === sequence + 1 && receipt.endSequence >= receipt.startSequence
      && json(receipt) === json(saved), 'Missing or changed append-only receipt.');
    sequence = receipt.endSequence;
  }
  invariant(sequence === checkpoint.publishedMessageCount, 'Unproven raw changes before publication.');
}
