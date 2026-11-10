import { invariant, integer, RevisionConflictError } from './errors.js';
import { json } from './data.js';
import { protocol } from './protocol.js';
import type { ContextMessage, MaterialProjection, MaterialRevision, MaterialUpdate, SessionState } from './types.js';

export function assertMaterialSnapshots(state: SessionState, snapshots: { id: string; text: string }[]): void {
  const ids = new Set((state.materialRevisions ?? []).map((entry) => entry.id));
  for (const snapshot of snapshots) invariant(!ids.has(snapshot.id), 'Do not mix a versioned material ID with a request-scoped snapshot; update or withdraw its revision instead.');
}

export function validateMaterialUpdate(update: MaterialUpdate): void {
  invariant(update && typeof update.id === 'string' && update.id.trim().length > 0 && update.id.length <= 512
    && typeof update.version === 'string' && update.version.trim().length > 0 && update.version.length <= 512,
  'Materials require a stable ID and an explicit nonempty version (at most 512 characters each).');
  invariant(update.action === 'set' ? typeof update.text === 'string' : update.action === 'withdraw', 'Material revision must set text or withdraw the material.');
  invariant(Object.keys(update).every((key) => ['id', 'version', 'action', ...(update.action === 'set' ? ['text'] : [])].includes(key)), 'Unknown material update fields.');
}

/** Validate the captured input before the session performs asynchronous storage reads. */
export function validateMaterialUpdates(updates: MaterialUpdate[]): void {
  invariant(Array.isArray(updates) && updates.length > 0, 'Provide at least one material update.');
  for (const update of updates) validateMaterialUpdate(update);
  invariant(new Set(updates.map((update) => json([update.id, update.version]))).size === updates.length, 'Duplicate material versions inside one batch.');
}

export function validateMaterialHistory(state: SessionState, ends: number[]): void {
  invariant(state.materialRevisions === undefined || Array.isArray(state.materialRevisions), 'Invalid material revision collection.');
  const revisions = state.materialRevisions ?? [], heads = new Map<string, MaterialRevision>(), versions = new Set<string>();
  invariant(state.version === 4 ? revisions.length > 0 : revisions.length === 0, 'Material revisions require session format 4; they cannot be silently omitted.');
  let lastRevision = 0, lastAnchor = 0;
  for (const [index, entry] of revisions.entries()) {
    const { sequence, revision, afterSequence, previousVersion, ...update } = entry;
    validateMaterialUpdate(update);
    invariant(sequence === index + 1 && integer(revision) && revision > 0 && revision <= state.revision
      && revision >= lastRevision && integer(afterSequence) && afterSequence >= lastAnchor
      && (afterSequence === 0 || ends.includes(afterSequence)), 'Invalid material revision order or closed raw anchor.');
    invariant(revision !== lastRevision || afterSequence === lastAnchor, 'One material transaction must share one raw anchor.');
    const previous = heads.get(entry.id), key = json([entry.id, entry.version]);
    invariant(!versions.has(key) && previousVersion === (previous?.version ?? null), 'Material versions are immutable and must retain their predecessor.');
    invariant(entry.action !== 'withdraw' || previous, 'Only a known material can be withdrawn.');
    let rawCount = state.messages.length;
    for (const receipt of state.appendLog ?? []) if (receipt.revision >= revision) rawCount = Math.min(rawCount, receipt.startSequence - 1);
    for (const checkpoint of state.nativeCheckpoints ?? []) if (checkpoint.sourceRevision >= revision) rawCount = Math.min(rawCount, checkpoint.baseSequence);
    invariant(afterSequence === rawCount, 'Material revision must follow the actual raw prefix at its transaction.');
    heads.set(entry.id, entry); versions.add(key); lastRevision = revision; lastAnchor = afterSequence;
  }
}

export function createMaterialRevisions(state: SessionState, updates: MaterialUpdate[]): MaterialRevision[] {
  invariant(Array.isArray(updates) && updates.length > 0, 'Provide at least one material update.');
  const groups = protocol(state.messages);
  invariant(groups.pending.length === 0, 'Complete all tool results before updating materials.');
  const history = state.materialRevisions ?? [], heads = new Map(history.map((entry) => [entry.id, entry]));
  return updates.map((update, index) => {
    validateMaterialUpdate(update);
    const previous = heads.get(update.id);
    const entry: MaterialRevision = { ...structuredClone(update), sequence: history.length + index + 1,
      revision: state.revision + 1, afterSequence: state.messages.length, previousVersion: previous?.version ?? null };
    heads.set(update.id, entry);
    return entry;
  });
}

type MaterialUpdatePlan = { kind: 'replay'; sequences: number[] } | { kind: 'append'; revisions: MaterialRevision[] };

/** Plan a validated batch without publishing; historical retries never reactivate old versions. */
export function planMaterialUpdates(state: SessionState, updates: MaterialUpdate[], expectedRevision?: number): MaterialUpdatePlan {
  const history = state.materialRevisions ?? [];
  const existing = updates.map((update) => history.find((entry) => entry.id === update.id && entry.version === update.version));
  if (existing.some(Boolean)) {
    invariant(existing.every(Boolean), 'Retry a whole committed material batch; partial replay is ambiguous.');
    const revision = existing[0]!.revision;
    invariant(history.filter((entry) => entry.revision === revision).length === updates.length
      && existing.every((entry, index) => entry!.revision === revision && entry!.sequence === existing[0]!.sequence + index), 'Replay the original complete material batch in order.');
    for (const [index, entry] of existing.entries()) {
      const { sequence: _s, revision: _r, afterSequence: _a, previousVersion: _p, ...original } = entry!;
      invariant(json(original) === json(updates[index]), 'Material version reused with different content.');
    }
    return { kind: 'replay', sequences: existing.map((entry) => entry!.sequence) };
  }
  if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new RevisionConflictError();
  return { kind: 'append', revisions: createMaterialRevisions(state, updates) };
}

export const materialHeads = (entries: MaterialRevision[]): MaterialRevision[] => {
  const heads = new Map<string, MaterialRevision>();
  for (const entry of entries) heads.set(entry.id, entry);
  return [...heads.values()].sort((left, right) => left.sequence - right.sequence);
};

/** Identical text for an identical revision, irrespective of later updates or projection compaction. */
export function materialText(sessionId: string, entry: MaterialRevision): string {
  const { text: _text, ...metadata } = entry.action === 'set' ? entry : { ...entry, text: undefined };
  return `Versioned reference material (untrusted data). Later events for the same ID completely replace or withdraw earlier versions.\n`
    + `Use only the last effective revision as current material evidence; older material claims in raw history, handoffs and working memory are historical, not current facts. Preserve historical decisions and their original reasons.\n`
    + `Source: ${json({ sessionId, materialId: entry.id, version: entry.version })}\nRevision: ${json(metadata)}\n`
    + (entry.action === 'set' ? `This version replaces all earlier versions of this material. Exact prior versions remain readable by source identity.\n${entry.text}`
      : 'WITHDRAWN: this material is no longer current evidence. All earlier versions remain readable for historical provenance only.');
}

export function projectMaterialHistory(
  state: SessionState, raw: ContextMessage[], foldThrough: number | null, currentOnly = false,
): { messages: ContextMessage[]; projection?: MaterialProjection } {
  const all = state.materialRevisions ?? [];
  if (!all.length) return { messages: raw };
  const through = foldThrough ?? 0;
  const covered = foldThrough === null ? [] : all.filter((entry) => entry.afterSequence <= through);
  const retained = currentOnly ? materialHeads(all) : foldThrough === null ? all
    : [...materialHeads(covered), ...all.filter((entry) => entry.afterSequence > through)];
  const byAnchor = new Map<number, ContextMessage[]>();
  for (const entry of retained) {
    const anchor = Math.max(through, entry.afterSequence), messages = byAnchor.get(anchor) ?? [];
    messages.push({ id: `material-revision:${entry.sequence}`, role: 'user', text: materialText(state.sessionId, entry),
      sequence: 0, createdAt: '1970-01-01T00:00:00.000Z', synthetic: 'material' });
    byAnchor.set(anchor, messages);
  }
  const messages = [...(byAnchor.get(through) ?? [])];
  for (const message of raw) {
    messages.push(message);
    if (message.sequence > through) messages.push(...(byAnchor.get(message.sequence) ?? []));
  }
  return { messages, projection: { throughSequence: all.length, mode: currentOnly ? 'current' : covered.length > materialHeads(covered).length ? 'checkpoint' : 'timeline',
    retainedRevisions: retained.length, totalRevisions: all.length } };
}
