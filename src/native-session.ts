import { randomUUID } from 'node:crypto';
import { ContextBudgetError, RevisionConflictError, invariant, integer } from './errors.js';
import { protocol } from './protocol.js';
import { assertPortableHistory, countNative, digest, nativeError, sameBinding, validateBinding } from './native.js';
import type { Message, PrepareOptions, SessionEvent, SessionState, SessionStore } from './types.js';
import type { NativeAdapter, NativeCheckpoint, NativePlan, NativePreparation, NativePreparedContext, NativeReceipt } from './native-types.js';

export async function prepareNativeContext(state: SessionState, options: PrepareOptions, adapter: NativeAdapter, store: SessionStore, emit: (event: SessionEvent) => void): Promise<NativePreparation> {
  if (store.supportsNativeState !== true) nativeError('NATIVE_STORAGE_UNSUPPORTED', 'Storage must explicitly support atomic native checkpoints before selecting native compaction.');
  validateBinding(adapter.binding);
  const { model } = options;
  const safety = options.safetyMarginTokens ?? Math.ceil(model.contextWindow * 0.03);
  invariant(integer(model.contextWindow) && model.contextWindow > 0 && integer(options.outputReserveTokens) && options.outputReserveTokens > 0 && integer(safety), 'Invalid native model budget.');
  invariant(model.maxOutputTokens === undefined || (integer(model.maxOutputTokens) && options.outputReserveTokens <= model.maxOutputTokens), 'Output reserve exceeds native model output capacity.');
  const available = model.contextWindow - options.outputReserveTokens - safety;
  if (available <= 0) throw new ContextBudgetError('No native input budget remains after output and safety reserves.');
  const threshold = options.compactAt ?? 0.85;
  invariant(threshold > 0 && threshold <= 1 && Number.isFinite(threshold), 'Invalid native compaction ratio.');
  if (adapter.mode === 'server-threshold') invariant(integer(adapter.thresholdTokens!) && adapter.thresholdTokens! > 0 && adapter.thresholdTokens! < available, 'Provider compaction threshold must be below the selected model input budget.');
  const binding = structuredClone(adapter.binding);
  const fixedHash = digest({ systemPrompt: options.systemPrompt ?? '', tools: options.tools ?? [], materials: options.materials ?? [] });
  let before = state.nativeCheckpoints?.at(-1);
  const compatible = before && sameBinding(before.binding, binding) && before.fixedHash === fixedHash && !options.rebuildNativeFromRaw;
  let origin: NativePreparedContext['origin'] = compatible ? 'resumed' : before || state.checkpoints.length ? 'rebuilt' : 'raw';
  const rebuildReason = !compatible && (before || state.checkpoints.length)
    ? options.rebuildNativeFromRaw ? 'explicit-raw-rebuild' : before && !sameBinding(before.binding, binding) ? 'backend-binding-changed' : before ? 'fixed-input-changed' : 'portable-to-native'
    : undefined;
  if (!compatible) assertPortableHistory(state);
  const complete = compatible ? before!.portableComplete : true;
  const makeRequest = (nativeState: NativeCheckpoint | undefined) => adapter.build({
    messages: structuredClone(state.messages.slice(nativeState?.throughSequence ?? 0)),
    state: nativeState ? structuredClone(nativeState.state) : null,
    systemPrompt: options.systemPrompt ?? '', tools: structuredClone(options.tools ?? []),
    materials: structuredClone(options.materials ?? []), outputReserveTokens: options.outputReserveTokens,
  });
  let current = compatible ? before : undefined;
  let request = makeRequest(current);
  let inputTokens = await countNative(adapter, request, current);
  let revision = state.revision;
  options.signal?.throwIfAborted();
  if (adapter.mode === 'on-demand' && inputTokens > Math.floor(available * threshold)) {
    if (inputTokens > model.contextWindow - safety) throw new ContextBudgetError('Raw/native window is already too large for the compact endpoint. Choose an explicit migration/rebuild plan; no fallback or truncation was performed.');
    invariant(adapter.compact, 'On-demand native adapter requires a compact operation.');
    if ((await store.load(state.sessionId))?.revision !== state.revision) throw new RevisionConflictError();
    const result = await adapter.compact(structuredClone(request), options.signal);
    options.signal?.throwIfAborted();
    const candidate: NativeCheckpoint = {
      id: randomUUID(), createdAt: new Date().toISOString(), sourceRevision: state.revision,
      previousId: before?.id ?? null, binding, fixedHash, phase: 'compaction', origin,
      baseSequence: state.messages.length, throughSequence: state.messages.length,
      throughId: state.messages.at(-1)!.id, publicMessageIds: [], portableComplete: complete,
      request: structuredClone(result.request), response: structuredClone(result.response), responseId: result.responseId, state: structuredClone(result.state),
    };
    const nextRequest = makeRequest(candidate);
    const nextTokens = await countNative(adapter, nextRequest, candidate);
    if (nextTokens > available) throw new ContextBudgetError('Native compaction completed but its canonical next window still exceeds the target input budget. Previous checkpoint retained.');
    options.signal?.throwIfAborted();
    const next = await store.commit(state.sessionId, state.revision, { nativeCheckpoint: candidate }, options.signal);
    invariant(next.nativeCheckpoints?.at(-1)?.id === candidate.id, 'Storage did not persist native continuation state.');
    revision = next.revision;
    current = candidate;
    before = candidate;
    request = nextRequest;
    inputTokens = nextTokens;
    origin = candidate.origin;
    emit({ type: 'native-committed', revision, checkpointId: candidate.id, phase: 'compaction' });
  }
  if (inputTokens > available) throw new ContextBudgetError('Native request exceeds the target budget. Native failures do not switch to portable summarization.');
  options.signal?.throwIfAborted();
  if ((await store.load(state.sessionId))?.revision !== revision) throw new RevisionConflictError();
  const context: NativePreparedContext = {
    strategy: 'native', id: randomUUID(), sessionId: state.sessionId, revision, modelId: model.id,
    binding, checkpointId: current?.id ?? null, origin,
    ...(rebuildReason ? { rebuildReason } : {}), request: structuredClone(request),
    budget: { contextWindow: model.contextWindow, inputTokens, outputReserveTokens: options.outputReserveTokens, safetyMarginTokens: safety, remainingTokens: available - inputTokens },
  };
  const plan: NativePlan = {
    adapter, binding: structuredClone(binding), fixedHash, context: structuredClone(context),
    requestHash: digest(request), before, portableComplete: complete,
  };
  emit({ type: 'native-prepared', revision, origin, checkpointId: context.checkpointId });
  return { context, plan };
}

export async function acceptNativeResponse(state: SessionState, context: NativePreparedContext, response: unknown, plan: NativePlan, store: SessionStore, signal?: AbortSignal): Promise<NativeReceipt> {
  invariant(digest(context) === digest(plan.context) && digest(context.request) === plan.requestHash, 'Prepared native request was modified.');
  invariant(sameBinding(plan.binding, plan.adapter.binding), 'Native adapter binding changed after preparing.');
  const responseHash = digest(response);
  if (plan.receipt) {
    invariant(plan.responseHash === responseHash, 'Prepared native response was replayed with different content.');
    return { ...structuredClone(plan.receipt), replayed: true };
  }
  if (state.revision !== plan.context.revision) throw new RevisionConflictError();
  signal?.throwIfAborted();
  const accepted = plan.adapter.accept(structuredClone(plan.context.request), structuredClone(response));
  if ((state.nativeCheckpoints ?? []).some((checkpoint) => sameBinding(checkpoint.binding, plan.binding) && checkpoint.responseId === accepted.responseId)) nativeError('NATIVE_RESPONSE_REPLAY', 'This provider response is already committed; do not execute its tools again.');
  const messages: Message[] = accepted.messages.map((message, index) => ({
    ...structuredClone(message), id: randomUUID(), createdAt: new Date().toISOString(), sequence: state.messages.length + index + 1,
  } as Message));
  protocol([...state.messages, ...messages]);
  const checkpoint: NativeCheckpoint = {
    id: randomUUID(), createdAt: new Date().toISOString(), sourceRevision: state.revision,
    previousId: state.nativeCheckpoints?.at(-1)?.id ?? null, binding: structuredClone(plan.binding), fixedHash: plan.fixedHash,
    phase: 'response', origin: plan.context.origin, baseSequence: state.messages.length,
    throughSequence: state.messages.length + messages.length, throughId: messages.at(-1)?.id ?? state.messages.at(-1)!.id,
    publicMessageIds: messages.map((message) => message.id), portableComplete: plan.portableComplete && accepted.portableComplete,
    request: structuredClone(plan.context.request), response: structuredClone(response) as NativeCheckpoint['response'], responseId: accepted.responseId, state: structuredClone(accepted.state),
  };
  signal?.throwIfAborted();
  const next = await store.commit(state.sessionId, state.revision, { messages, nativeCheckpoint: checkpoint }, signal);
  invariant(next.nativeCheckpoints?.at(-1)?.id === checkpoint.id, 'Storage did not persist native continuation state.');
  const receipt: NativeReceipt = { revision: next.revision, messageIds: checkpoint.publicMessageIds, nativeCheckpointId: checkpoint.id, responseId: checkpoint.responseId, replayed: false };
  plan.responseHash = responseHash;
  plan.receipt = structuredClone(receipt);
  return receipt;
}
