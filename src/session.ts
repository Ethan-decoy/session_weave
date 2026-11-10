import { randomUUID } from 'node:crypto';
import { ContextBudgetError, RevisionConflictError, SessionWeaveError, invariant, integer } from './errors.js';
import { json, jsonDigest } from './data.js';
import { protocol } from './protocol.js';
import { createWorkingMemoryCheckpoint, emptyState, mutate, validateState } from './session-state.js';
import { PortableContextBuilder } from './context.js';
import { compactHandoff } from './handoff.js';
import { assertPortableHistory, nativeError, selectCompactionStrategy } from './native.js';
import { acceptNativeResponse, prepareNativeContext } from './native-session.js';
import { presentRawPage } from './raw-page.js';
import { captureMemoryProvenance, memoryDigest, memoryPublicationBase } from './memory-provenance.js';
import { materialHeads, planMaterialUpdates, validateMaterialUpdates } from './materials.js';
import { withMemoryContext } from './model-call.js';
import type { NativeCheckpoint, NativePlan, NativePreparedContext, NativeReceipt, RuntimePlan, RuntimePrepareOptions } from './native-types.js';
import type {
  Checkpoint, MaterialRevision, MaterialUpdate, Message, MessageInput, PreparedContext, PrepareOptions, RawPage, ReadPageOptions,
  Reference, SessionEvent, SessionState, SessionStore, Summarizer, UsageObservation,
  WorkingMemoryCandidate, WorkingMemoryCheckpoint, WorkingMemoryEngine, WorkingMemoryIdentity,
  WorkingMemoryProvenance, WorkingMemoryReceipt, WorkingMemoryTicket,
} from './types.js';

const lastCheckpoint = (state: SessionState) => state.checkpoints.at(-1);
type MemoryTicketPlan = { candidate: WorkingMemoryCandidate; provenance: WorkingMemoryProvenance; sourceDigest: string; identity: WorkingMemoryIdentity; used: boolean };
type MemoryInfo = Pick<WorkingMemoryCheckpoint, 'id' | 'identity' | 'sourceRevision' | 'sourceThroughSequence' | 'activeThroughSequence' | 'version'> & { publishedFromRevision: number };
function previousMemory(state: SessionState, identity: WorkingMemoryIdentity): WorkingMemoryCheckpoint | null {
  const previous = state.workingMemoryCheckpoints?.at(-1);
  return previous && json(previous.identity) === json(identity)
    && (state.nativeCheckpoints?.at(-1)?.sourceRevision ?? -1) <= memoryPublicationBase(previous) ? previous : null;
}
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

/** The actor context and its capacity observation refer to the same publication. */
function setPreparedRevision(context: PreparedContext, revision: number): void {
  context.revision = revision;
  context.usageBasis.revision = revision;
}

export class SessionWeave {
  private readonly nativePlans = new WeakMap<NativePreparedContext, NativePlan>();
  private readonly memoryTickets = new WeakMap<WorkingMemoryTicket, MemoryTicketPlan>();
  private constructor(
    readonly sessionId: string, private readonly store: SessionStore,
    private readonly summarizer?: Summarizer, private readonly onEvent?: (event: SessionEvent) => void,
    private readonly workingMemory?: WorkingMemoryEngine,
  ) {}
  static async open(options: { sessionId: string; store: SessionStore; summarizer?: Summarizer; workingMemory?: WorkingMemoryEngine; onEvent?: (event: SessionEvent) => void }): Promise<SessionWeave> {
    emptyState(options.sessionId);
    invariant(!(options.summarizer && options.workingMemory), 'Configure one portable memory engine or summarizer.');
    const session = new SessionWeave(options.sessionId, options.store, options.summarizer, options.onEvent, options.workingMemory);
    const state = await session.load();
    session.emit({ type: 'restored', revision: state.revision, messages: state.messages.length, pendingCallIds: protocol(state.messages).pending });
    return session;
  }
  private emit(event: SessionEvent): void {
    try { void Promise.resolve(this.onEvent?.(event)).catch(() => undefined); }
    catch { /* Observers cannot turn a committed write into an apparent failure. */ }
  }
  private async load(): Promise<SessionState> {
    const state = await this.store.load(this.sessionId) ?? emptyState(this.sessionId);
    invariant(state.sessionId === this.sessionId, 'Store returned another session.');
    validateState(state);
    if (state.workingMemoryCheckpoints?.length) this.requireWorkingMemoryStore(state.workingMemoryCheckpoints.some((checkpoint) => checkpoint.version === 2));
    if (state.materialRevisions?.length) this.requireMaterialStore();
    return structuredClone(state);
  }
  private requireWorkingMemoryStore(provenance = false): void {
    if (this.store.supportsWorkingMemoryState !== true) throw new SessionWeaveError('WORKING_MEMORY_STORAGE_UNSUPPORTED', 'Storage must support atomic complete working-memory records before reading or publishing them.');
    if (provenance && this.store.supportsWorkingMemoryProvenance !== true) throw new SessionWeaveError('WORKING_MEMORY_PROVENANCE_UNSUPPORTED', 'Storage must preserve append receipts and provenance packages atomically before precomputation or adoption.');
  }
  private requireMaterialStore(): void {
    if (this.store.supportsMaterialRevisions !== true) throw new SessionWeaveError('MATERIAL_STORAGE_UNSUPPORTED', 'Storage must preserve immutable material revisions and raw anchors atomically before reading or updating them.');
  }
  async inspect(): Promise<{ sessionId: string; revision: number; messageCount: number; checkpoint: Checkpoint | null; pendingCallIds: string[]; nativeCheckpoint: Pick<NativeCheckpoint, 'id' | 'binding' | 'throughSequence' | 'portableComplete'> | null; workingMemoryCheckpoint: MemoryInfo | null; materials: Pick<MaterialRevision, 'id' | 'version' | 'action' | 'sequence'>[] }> {
    const state = await this.load();
    const native = state.nativeCheckpoints?.at(-1);
    const memory = state.workingMemoryCheckpoints?.at(-1);
    return { sessionId: this.sessionId, revision: state.revision, messageCount: state.messages.length, checkpoint: lastCheckpoint(state) ?? null, pendingCallIds: protocol(state.messages).pending,
      nativeCheckpoint: native ? { id: native.id, binding: native.binding, throughSequence: native.throughSequence, portableComplete: native.portableComplete } : null,
      workingMemoryCheckpoint: memory ? { id: memory.id, version: memory.version, identity: memory.identity, sourceRevision: memory.sourceRevision, publishedFromRevision: memoryPublicationBase(memory), sourceThroughSequence: memory.sourceThroughSequence, activeThroughSequence: memory.activeThroughSequence } : null,
      materials: materialHeads(state.materialRevisions ?? []).map(({ id, version, action, sequence }) => ({ id, version, action, sequence })) };
  }
  /** Commit material truth independently of actor messages, only at a closed protocol boundary. */
  async updateMaterials(updates: MaterialUpdate[], options: { expectedRevision?: number; signal?: AbortSignal } = {}): Promise<{ revision: number; sequences: number[] }> {
    const { expectedRevision, signal } = options;
    this.requireMaterialStore();
    abort(signal);
    updates = structuredClone(updates);
    validateMaterialUpdates(updates);
    const state = await this.load(), plan = planMaterialUpdates(state, updates, expectedRevision);
    if (plan.kind === 'replay') {
      abort(signal);
      return { revision: state.revision, sequences: plan.sequences };
    }
    const materialRevisions = plan.revisions, mutation = { materialRevisions };
    mutate(state, mutation);
    abort(signal);
    const next = await this.store.commit(this.sessionId, state.revision, mutation, signal);
    validateState(next);
    invariant(next.revision === state.revision + 1 && json(next.materialRevisions) === json([...(state.materialRevisions ?? []), ...materialRevisions]), 'Storage did not preserve the complete material revision history.');
    this.emit({ type: 'materials-committed', revision: next.revision, throughSequence: next.materialRevisions!.length });
    return { revision: next.revision, sequences: materialRevisions.map((entry) => entry.sequence) };
  }
  /** Generate against a captured closed prefix without publishing or claiming an actor request. */
  async precomputeWorkingMemory(options: { throughId: string; reflow?: boolean; signal?: AbortSignal }): Promise<WorkingMemoryTicket> {
    const { throughId, signal } = options, reflow = options.reflow ?? false;
    this.requireWorkingMemoryStore(true);
    abort(signal);
    const engine = this.workingMemory;
    if (!engine) throw new SessionWeaveError('WORKING_MEMORY_NOT_READY', 'Configure a working-memory engine before precomputation.');
    const identity = structuredClone(engine.identity), state = await this.load();
    assertPortableHistory(state);
    const end = state.messages.findIndex((message) => message.id === throughId) + 1;
    invariant(end > 0 && protocol(state.messages).ends.includes(end) && typeof reflow === 'boolean', 'Precomputation requires an explicit closed raw prefix.');
    const previous = previousMemory(state, identity);
    invariant(!previous || previous.sourceThroughSequence <= end, 'The fixed prefix must include the actual previous engine input.');
    const provenance = captureMemoryProvenance(state, previous), sourceDigest = memoryDigest(state, end);
    const candidate = structuredClone(await withMemoryContext({ sessionId: this.sessionId, sourceRevision: state.revision,
      checkpointId: previous?.id ?? null, throughId }, () => engine.derive({ sessionId: this.sessionId, sourceRevision: state.revision,
      messages: structuredClone(state.messages.slice(0, end)), previous: structuredClone(previous), reflow }, signal)));
    abort(signal);
    invariant(candidate.sourceRevision === state.revision && candidate.sourceThroughId === throughId && json(candidate.identity) === json(identity)
      && json(engine.identity) === json(identity), 'Precomputed engine returned another source or identity.');
    mutate(state, { workingMemoryCheckpoint: createWorkingMemoryCheckpoint(state, candidate) });
    const ticket: WorkingMemoryTicket = Object.freeze({ id: randomUUID(), sessionId: this.sessionId, sourceRevision: state.revision, sourceThroughId: throughId });
    this.memoryTickets.set(ticket, { candidate, provenance, sourceDigest, identity, used: false });
    return ticket;
  }
  /** Publish one complete engine state and its historical projection at the observed raw revision. */
  async publishWorkingMemory(candidate: WorkingMemoryCandidate, options: { signal?: AbortSignal } = {}): Promise<WorkingMemoryReceipt> {
    this.requireWorkingMemoryStore();
    candidate = structuredClone(candidate);
    abort(options.signal);
    const state = await this.load();
    if (state.revision !== candidate.sourceRevision) throw new RevisionConflictError();
    const checkpoint = createWorkingMemoryCheckpoint(state, candidate);
    const next = await this.commitWorkingMemory(state, checkpoint, options.signal);
    return { revision: next.revision, checkpointId: checkpoint.id, activeThroughSequence: checkpoint.activeThroughSequence };
  }
  private async commitWorkingMemory(state: SessionState, checkpoint: WorkingMemoryCheckpoint, signal?: AbortSignal): Promise<SessionState> {
    const mutation = { workingMemoryCheckpoint: checkpoint };
    mutate(state, mutation); // Validate before asking even a custom store to publish.
    abort(signal);
    const next = await this.store.commit(this.sessionId, state.revision, mutation, signal);
    validateState(next);
    const saved = next.workingMemoryCheckpoints?.at(-1);
    invariant(saved && next.revision === state.revision + 1 && json(saved) === json(checkpoint), 'Storage did not publish the complete working-memory package.');
    this.emit({ type: 'working-memory-committed', revision: next.revision, checkpointId: checkpoint.id, activeThroughSequence: checkpoint.activeThroughSequence });
    return next;
  }
  async append(inputs: MessageInput[], options: { expectedRevision?: number; usage?: UsageObservation } = {}): Promise<{ revision: number; messageIds: string[] }> {
    invariant(Array.isArray(inputs) && inputs.length > 0, 'Append requires at least one completed message.');
    inputs = structuredClone(inputs);
    options = structuredClone(options);
    const state = await this.load();
    const explicitIds = inputs.flatMap((input) => input.id ? [input.id] : []);
    invariant(new Set(explicitIds).size === explicitIds.length, 'Duplicate IDs inside an append batch.');
    const existing = inputs.map((input) => input.id ? state.messages.find((message) => message.id === input.id) : undefined);
    if (existing.some(Boolean)) {
      invariant(existing.every(Boolean), 'Retry a whole already-committed batch; partial batch replay is ambiguous.');
      invariant(existing.every((message, index) => index === 0 || message!.sequence === existing[index - 1]!.sequence + 1), 'Replayed messages must retain their original contiguous order.');
      for (const [index, old] of existing.entries()) {
        const { sequence: _sequence, createdAt: _createdAt, ...original } = old!;
        invariant(jsonDigest(original) === jsonDigest(inputs[index]), 'Message ID reused with different content.');
      }
      return { revision: state.revision, messageIds: existing.map((message) => message!.id) };
    }
    if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) throw new RevisionConflictError();
    if (options.usage) {
      invariant(options.usage.basis.sessionId === this.sessionId, 'Usage belongs to another session.');
      if (options.usage.basis.revision !== state.revision) throw new RevisionConflictError();
      invariant(inputs[0]?.role === 'assistant', 'Usage must be recorded with the generated assistant response.');
    }
    const messages = inputs.map((input, index) => ({ ...structuredClone(input), id: input.id ?? randomUUID(), sequence: state.messages.length + index + 1, createdAt: new Date().toISOString() } as Message));
    protocol([...state.messages, ...messages]);
    const mutation = options.usage ? { messages, usage: options.usage } : { messages };
    const next = await this.store.commit(this.sessionId, state.revision, mutation);
    return { revision: next.revision, messageIds: messages.map((message) => message.id) };
  }
  async read(reference: Reference): Promise<Message[]>;
  async read(reference: { sessionId: string; nativeCheckpointId: string }): Promise<NativeCheckpoint>;
  async read(reference: { sessionId: string; workingMemoryCheckpointId: string }): Promise<WorkingMemoryCheckpoint>;
  async read(reference: { sessionId: string; materialId: string; version: string }): Promise<MaterialRevision>;
  async read(reference: Reference | { sessionId: string; nativeCheckpointId: string } | { sessionId: string; workingMemoryCheckpointId: string } | { sessionId: string; materialId: string; version: string }): Promise<Message[] | NativeCheckpoint | WorkingMemoryCheckpoint | MaterialRevision> {
    invariant(reference.sessionId === this.sessionId, 'Reference belongs to another session.');
    const state = await this.load();
    if ('materialId' in reference) {
      const material = state.materialRevisions?.find((entry) => entry.id === reference.materialId && entry.version === reference.version);
      invariant(material, 'Material version does not exist in this session.');
      return structuredClone(material);
    }
    if ('workingMemoryCheckpointId' in reference) {
      const checkpoint = state.workingMemoryCheckpoints?.find((item) => item.id === reference.workingMemoryCheckpointId);
      invariant(checkpoint, 'Working-memory checkpoint does not exist in this session.');
      return structuredClone(checkpoint);
    }
    if ('nativeCheckpointId' in reference) {
      const checkpoint = state.nativeCheckpoints?.find((item) => item.id === reference.nativeCheckpointId);
      invariant(checkpoint, 'Native checkpoint does not exist in this session.');
      return structuredClone(checkpoint);
    }
    const start = state.messages.findIndex((message) => message.id === reference.startId);
    const end = state.messages.findIndex((message) => message.id === reference.endId);
    invariant(start >= 0 && end >= start, 'Raw range does not exist or is reversed.');
    return structuredClone(state.messages.slice(start, end + 1));
  }
  /** Read-only evidence presentation; the counter includes the host's actual result envelope. */
  async readPage(reference: Reference, options: ReadPageOptions): Promise<RawPage> {
    const range = structuredClone(reference);
    invariant(range && Object.keys(range).length === 3 && ['sessionId', 'startId', 'endId'].every((key) => typeof range[key as keyof Reference] === 'string'), 'A raw page requires one explicit raw range.');
    invariant(typeof options.countTokens === 'function', 'A page envelope token counter is required.');
    const captured = { maxTokens: options.maxTokens, countTokens: options.countTokens.bind(options),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}), ...(options.signal ? { signal: options.signal } : {}) };
    captured.signal?.throwIfAborted();
    return presentRawPage(await this.read(range), range, captured);
  }
  async prepare(options: PrepareOptions & { strategy: 'portable' }): Promise<PreparedContext>;
  async prepare(options: RuntimePrepareOptions): Promise<RuntimePlan>;
  async prepare(options: PrepareOptions): Promise<PreparedContext | NativePreparedContext>;
  async prepare(options: PrepareOptions | RuntimePrepareOptions): Promise<PreparedContext | NativePreparedContext | RuntimePlan> {
    abort(options.signal);
    if ('runtime' in options) {
      invariant(!('workingMemoryTicket' in options), 'A working-memory ticket requires a new portable API prepare.');
      invariant(options.runtime && typeof options.runtime.id === 'string' && options.runtime.id.trim() && typeof options.runtime.sessionId === 'string' && options.runtime.sessionId.trim(), 'A selected runtime and explicit native session ID are required.');
      invariant(!('model' in options) && !('strategy' in options), 'Select one backend; runtime delegation does not prepare an API context.');
      if (options.runtime.capabilities?.persistentSessions !== true || options.runtime.capabilities?.compaction !== true) nativeError('UNSUPPORTED_STRATEGY', 'Verify this selected runtime provides persistent sessions and compaction before delegating.');
      invariant(typeof options.runtime.evidence === 'string' && options.runtime.evidence.trim(), 'Runtime capability evidence is required.');
      const delegate = { id: options.runtime.id, sessionId: options.runtime.sessionId };
      const state = await this.load();
      if (state.materialRevisions?.length) nativeError('UNSUPPORTED_STRATEGY', 'Runtime delegation cannot project committed material revisions. Select a portable/native API context or explicitly migrate materials into the external runtime.');
      return { strategy: 'runtime', sessionId: this.sessionId, revision: state.revision, delegate };
    }
    options = { ...options, model: { id: options.model.id, contextWindow: options.model.contextWindow,
      ...(options.model.maxOutputTokens !== undefined ? { maxOutputTokens: options.model.maxOutputTokens } : {}),
      ...(options.model.nativeCompaction ? { nativeCompaction: options.model.nativeCompaction } : {}),
      countTokens: options.model.countTokens.bind(options.model), ...(options.model.backend ? { backend: structuredClone(options.model.backend) } : {}) },
      tools: structuredClone(options.tools ?? []), materials: structuredClone(options.materials ?? []) };
    const selected = selectCompactionStrategy(options.model, options.strategy);
    if (options.workingMemoryTicket && selected.strategy !== 'portable') throw new SessionWeaveError('WORKING_MEMORY_TICKET_INVALID', 'A ticket cannot change native strategy selection; explicitly choose a compatible portable request.');
    if (selected.strategy === 'portable') {
      return this.preparePortable(options);
    }
    const state = await this.load();
    invariant(state.messages.length > 0, 'Append a user message before preparing native context.');
    const groups = protocol(state.messages);
    if (groups.pending.length) nativeError('PENDING_TOOLS', `Record real tool results before native continuation: ${groups.pending.join(', ')}`);
    const prepared = await prepareNativeContext(state, options, selected.adapter, this.store, (event) => this.emit(event));
    this.nativePlans.set(prepared.context, prepared.plan);
    return prepared.context;
  }
  async accept(context: NativePreparedContext, response: unknown, options: { signal?: AbortSignal } = {}): Promise<NativeReceipt> {
    const plan = this.nativePlans.get(context);
    if (!plan || context.sessionId !== this.sessionId) nativeError('NATIVE_PLAN_INVALID', 'Native response requires the unchanged plan issued by this open session. Restore a checkpoint, not an in-flight plan.');
    const capturedContext = structuredClone(context), capturedResponse = structuredClone(response);
    const receipt = await acceptNativeResponse(await this.load(), capturedContext, capturedResponse, plan, this.store, options.signal);
    if (!receipt.replayed) this.emit({ type: 'native-committed', revision: receipt.revision, checkpointId: receipt.nativeCheckpointId, phase: 'response' });
    return receipt;
  }
  private async preparePortable(options: PrepareOptions): Promise<PreparedContext> {
    abort(options.signal);
    const state = await this.load();
    assertPortableHistory(state);
    invariant(state.messages.length > 0, 'Append a user message before preparing context.');
    const groups = protocol(state.messages);
    if (groups.pending.length) throw new SessionWeaveError('PENDING_TOOLS', `Record real results for pending calls before requesting the model: ${groups.pending.join(', ')}`);
    const builder = new PortableContextBuilder(options);
    const available = builder.availableTokens;
    const threshold = options.compactAt ?? 0.85, keep = options.keepRecentGroups ?? 2;
    invariant(Number.isFinite(threshold) && threshold > 0 && threshold <= 1 && integer(keep) && keep > 0, 'Invalid compaction or recent-history policy.');
    const through = groups.ends.at(-(keep + 1)) ?? 0;
    if (options.workingMemoryTicket || this.workingMemory || state.workingMemoryCheckpoints?.length) {
      return this.prepareMemory(state, options, through, builder, threshold);
    }
    const previous = lastCheckpoint(state);
    const rebuildFromRaw = (state.nativeCheckpoints?.at(-1)?.sourceRevision ?? -1) > (previous?.sourceRevision ?? -1);
    const checkpoint = rebuildFromRaw ? undefined : previous;
    let context = await builder.handoff(state, checkpoint ?? null, rebuildFromRaw);
    const reflow = checkpoint && context.budget.inputTokens > available;
    if (context.budget.inputTokens > Math.floor(available * threshold) && (through > (checkpoint?.throughSequence ?? 0) || reflow)) {
      const candidateThrough = Math.max(through, previous?.throughSequence ?? 0);
      this.emit({ type: 'compaction-started', revision: context.revision, throughId: state.messages[candidateThrough - 1]!.id });
      try {
        const candidate = await compactHandoff(state, candidateThrough, this.summarizer, options.signal, rebuildFromRaw);
        const prepared = await builder.handoff(state, candidate, rebuildFromRaw);
        if (prepared.budget.inputTokens > available) throw new ContextBudgetError('Handoff, pinned input and recent groups still exceed the target model budget.');
        abort(options.signal);
        const next = await this.store.commit(this.sessionId, state.revision, { checkpoint: candidate }, options.signal);
        context = prepared;
        setPreparedRevision(context, next.revision);
        this.emit({ type: 'compaction-committed', revision: next.revision, checkpointId: candidate.id });
      } catch (error) {
        this.emit({ type: 'compaction-failed', revision: context.revision, error });
        throw error;
      }
    }
    if (context.budget.inputTokens > available) throw new ContextBudgetError('Current input, fixed instructions/materials or protected recent groups exceed the model window. Narrow the input; no raw records were truncated.');
    abort(options.signal);
    if ((await this.load()).revision !== context.revision) throw new RevisionConflictError();
    return context;
  }

  private async prepareMemory(
    state: SessionState,
    options: PrepareOptions,
    through: number,
    builder: PortableContextBuilder,
    threshold: number,
  ): Promise<PreparedContext> {
    if (options.workingMemoryTicket) return this.adoptMemory(state, options, options.workingMemoryTicket, through, builder);
    const previous = state.workingMemoryCheckpoints?.at(-1);
    const engine = this.workingMemory;
    const rebuild = (state.nativeCheckpoints?.at(-1)?.sourceRevision ?? -1) > (previous ? memoryPublicationBase(previous) : -1)
      || !!(previous && engine && json(previous.identity) !== json(engine.identity));
    const checkpoint = rebuild ? undefined : previous;
    const available = builder.availableTokens;
    let context = await builder.workingMemory(state, checkpoint ?? null, through, rebuild);
    const reflow = !!checkpoint && context.budget.inputTokens > available;
    if (context.budget.inputTokens > Math.floor(available * threshold)
      && (through > (checkpoint?.sourceThroughSequence ?? 0) || reflow)) {
      if (!engine) throw new SessionWeaveError('WORKING_MEMORY_NOT_READY', 'Configure a working-memory engine to update this checkpoint; its saved projection can be reused while it fits.');
      this.requireWorkingMemoryStore();
      const end = Math.max(through, previous?.sourceThroughSequence ?? 0);
      const throughId = state.messages[end - 1]!.id;
      this.emit({ type: 'compaction-started', revision: context.revision, throughId });
      try {
        abort(options.signal);
        const candidate = structuredClone(await withMemoryContext({ sessionId: this.sessionId, sourceRevision: state.revision,
          checkpointId: checkpoint?.id ?? null, throughId }, () => engine.derive({ sessionId: this.sessionId, sourceRevision: state.revision,
          messages: structuredClone(state.messages.slice(0, end)), previous: structuredClone(checkpoint ?? null), reflow }, options.signal)));
        abort(options.signal);
        invariant(candidate.sourceRevision === state.revision && candidate.sourceThroughId === throughId
          && json(candidate.identity) === json(engine.identity), 'Working-memory engine returned a different source or identity.');
        const memory = createWorkingMemoryCheckpoint(state, candidate);
        mutate(state, { workingMemoryCheckpoint: memory });
        const prepared = await builder.workingMemory(state, memory, through);
        if (prepared.budget.inputTokens > available) throw new ContextBudgetError('Working memory, current instructions/materials and protected raw groups exceed the target model budget.');
        abort(options.signal);
        const next = await this.commitWorkingMemory(state, memory, options.signal);
        context = prepared;
        setPreparedRevision(context, next.revision);
      } catch (error) {
        this.emit({ type: 'compaction-failed', revision: context.revision, error });
        throw error;
      }
    }
    if (context.budget.inputTokens > available) throw new ContextBudgetError('Working memory or protected current input cannot fit the target model window.');
    abort(options.signal);
    if ((await this.load()).revision !== context.revision) throw new RevisionConflictError();
    return context;
  }

  private async adoptMemory(
    state: SessionState,
    options: PrepareOptions,
    ticket: WorkingMemoryTicket,
    through: number,
    builder: PortableContextBuilder,
  ): Promise<PreparedContext> {
    this.requireWorkingMemoryStore(true);
    const plan = this.memoryTickets.get(ticket);
    if (!plan || !this.workingMemory || json(this.workingMemory.identity) !== json(plan.identity)) throw new SessionWeaveError('WORKING_MEMORY_TICKET_INVALID', 'Use the unchanged ticket in its original open session with the same engine, codec and policy.');
    if (plan.used) throw new RevisionConflictError();
    const checkpoint: Extract<WorkingMemoryCheckpoint, { version: 2 }> = {
      ...createWorkingMemoryCheckpoint(state, plan.candidate), version: 2, sourceDigest: plan.sourceDigest,
      publishedFromRevision: state.revision, publishedMessageCount: state.messages.length, publishedRawDigest: memoryDigest(state, state.messages.length),
      provenance: { ...structuredClone(plan.provenance), appendReceipts: structuredClone((state.appendLog ?? []).filter((receipt) => receipt.revision > plan.candidate.sourceRevision && receipt.revision <= state.revision)) },
    };
    try { mutate(state, { workingMemoryCheckpoint: checkpoint }); }
    catch (error) { const conflict = new RevisionConflictError(); conflict.cause = error; throw conflict; }
    abort(options.signal);
    const context = await builder.workingMemory(state, checkpoint, through);
    if (context.budget.inputTokens > builder.availableTokens) throw new ContextBudgetError('Precomputed memory and the current protected request exceed the target window. The ticket is not published.');
    abort(options.signal);
    const next = await this.commitWorkingMemory(state, checkpoint, options.signal);
    plan.used = true;
    abort(options.signal);
    if ((await this.load()).revision !== next.revision) throw new RevisionConflictError();
    setPreparedRevision(context, next.revision);
    return context;
  }
}
