import type { CompactionStrategy, NativeBinding, NativeCapability, NativeCheckpoint } from './native-types.js';

export type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };
export type ToolCall = { id: string; name: string; arguments: { [key: string]: Json } };
export type MessageInput = (
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; text: string; isError: boolean }
) & { id?: string };
export type Message = MessageInput & { id: string; sequence: number; createdAt: string };
export type Reference = { sessionId: string; startId: string; endId: string };
/** A slice of canonical JSON for one complete raw Message; never a replacement raw record. */
export type RawPage = {
  version: 1;
  range: Reference;
  rangeDigest: string;
  /** Actual message supplying this fragment. */
  source: Reference;
  sequence: number;
  format: 'sessionweave-message-json@1';
  position: { unit: 'utf16-code-unit'; start: number; end: number; total: number };
  text: string;
  /** True only at the end of the entire selected range. */
  done: boolean;
  nextCursor: string | null;
};
export type ReadPageOptions = {
  cursor?: string;
  maxTokens: number;
  /** Count the ENTIRE page and the host's actual tool-result envelope. No whole-request guarantee. */
  countTokens(page: RawPage): number | Promise<number>;
  signal?: AbortSignal;
};
export type Note = { text: string; refs: Reference[] };
export type Handoff = {
  version: 1;
  goals: Note[];
  constraints: Note[];
  decisions: (Note & { rationale: string })[];
  completed: Note[];
  openQuestions: Note[];
  corrections: Note[];
};
export type Checkpoint = {
  id: string;
  createdAt: string;
  sourceRevision: number;
  throughId: string;
  throughSequence: number;
  previousId: string | null;
  summarizerId: string;
  handoff: Handoff;
};
/** Versioned adapter identities. The engine-specific codec owns the JSON state format. */
export type WorkingMemoryIdentity = { engine: string; codec: string; policy: string };
export type WorkingMemoryCandidate = {
  complete: true;
  sourceRevision: number;
  /** Full closed prefix supplied to the engine, including any buffered input. */
  sourceThroughId: string;
  /** Prefix represented by projection; null keeps every raw message active. */
  activeThroughId: string | null;
  identity: WorkingMemoryIdentity;
  engineState: { [key: string]: Json };
  projection: string;
  sources: Reference[];
};
export type AppendReceipt = { revision: number; startSequence: number; endSequence: number };
export type WorkingMemoryProvenance = {
  sourceMessageCount: number;
  sourceRawDigest: string;
  sourceMetadataDigest: string;
  base: { workingMemoryId: string | null; nativeId: string | null; handoffId: string | null; digest: string };
  previousUsedId: string | null;
  appendReceipts: AppendReceipt[];
};
export type WorkingMemoryCheckpoint = WorkingMemoryCandidate & {
  id: string;
  createdAt: string;
  previousId: string | null;
  sourceThroughSequence: number;
  activeThroughSequence: number;
  sourceDigest: string;
} & ({ version: 1 } | { version: 2; publishedFromRevision: number; publishedMessageCount: number; publishedRawDigest: string; provenance: WorkingMemoryProvenance });
/** Ephemeral handle owned by the open instance; copies are not adoptable. */
export type WorkingMemoryTicket = Readonly<{ id: string; sessionId: string; sourceRevision: number; sourceThroughId: string }>;
export type WorkingMemoryReceipt = { revision: number; checkpointId: string; activeThroughSequence: number };
/** Derive in isolation; publication and the final target budget belong to SessionWeave. */
export interface WorkingMemoryEngine {
  readonly identity: WorkingMemoryIdentity;
  derive(request: {
    sessionId: string;
    sourceRevision: number;
    /** Complete closed raw prefix. The engine selects its delta using previous. */
    messages: Message[];
    previous: WorkingMemoryCheckpoint | null;
    /** Reorganize existing memory when the current target window is smaller. */
    reflow: boolean;
  }, signal?: AbortSignal): Promise<WorkingMemoryCandidate>;
}
export type ContextMessage = Message & { synthetic?: 'handoff' | 'material' | 'working-memory' };
export type ModelInput = { systemPrompt: string; tools: Json[]; messages: ContextMessage[] };
export type ModelProfile = {
  /** Include provider, model and tokenizer revision; usage observations are scoped to this key. */
  id: string;
  contextWindow: number;
  maxOutputTokens?: number;
  countTokens(input: ModelInput): number | Promise<number>;
  backend?: NativeBinding;
  nativeCompaction?: NativeCapability;
};
export type UsageBasis = {
  sessionId: string;
  revision: number;
  modelId: string;
  fixedHash: string;
  checkpointId: string | null;
  messageIds: string[];
  estimatedInputTokens: number;
};
export type UsageObservation = { basis: UsageBasis; inputTokens: number; outputTokens: number };
export type SessionState = {
  version: 1 | 2 | 3;
  sessionId: string;
  revision: number;
  messages: Message[];
  checkpoints: Checkpoint[];
  usage: UsageObservation[];
  nativeCheckpoints?: NativeCheckpoint[];
  workingMemoryCheckpoints?: WorkingMemoryCheckpoint[];
  /** Optional optimization receipts; missing history makes reuse fail closed. */
  appendLog?: AppendReceipt[];
};
export type Mutation = { messages?: Message[]; checkpoint?: Checkpoint; usage?: UsageObservation; nativeCheckpoint?: NativeCheckpoint; workingMemoryCheckpoint?: WorkingMemoryCheckpoint };
/** Must atomically compare revision and append only; never mutate existing raw records. */
export interface SessionStore {
  readonly supportsNativeState?: boolean;
  readonly supportsWorkingMemoryState?: boolean;
  readonly supportsWorkingMemoryProvenance?: boolean;
  load(sessionId: string): Promise<SessionState | null>;
  commit(sessionId: string, expectedRevision: number, mutation: Mutation, signal?: AbortSignal): Promise<SessionState>;
}
export type SummaryRequest = {
  sessionId: string;
  sourceRevision: number;
  previous: Handoff | null;
  messages: Message[];
  throughId: string;
  input: ModelInput;
  maxOutputTokens: number;
};
export type SummaryResult = { complete: true; throughId: string; handoff: Handoff };
export interface Summarizer {
  model: ModelProfile;
  outputReserveTokens: number;
  summarize(request: SummaryRequest, signal?: AbortSignal): Promise<SummaryResult>;
}
export type PrepareOptions = {
  model: ModelProfile;
  /** Auto requires deployment-specific capability evidence. Missing evidence is unknown. */
  strategy?: CompactionStrategy;
  /** Explicitly abandon a resumable native state and rebuild from canonical raw records. */
  rebuildNativeFromRaw?: boolean;
  /** Explicit adoption in this new portable request, owned by this open instance. */
  workingMemoryTicket?: WorkingMemoryTicket;
  systemPrompt?: string;
  tools?: Json[];
  materials?: { id: string; text: string }[];
  outputReserveTokens: number;
  safetyMarginTokens?: number;
  /** Fraction of input budget at which to compact proactively. Default 0.85. */
  compactAt?: number;
  /** Complete recent protocol groups to preserve, in addition to the latest user input. Default 2. */
  keepRecentGroups?: number;
  signal?: AbortSignal;
};
export type PreparedContext = ModelInput & {
  strategy: 'portable';
  origin: 'raw' | 'handoff' | 'rebuilt' | 'working-memory';
  sessionId: string;
  revision: number;
  modelId: string;
  checkpointId: string | null;
  budget: {
    contextWindow: number;
    inputTokens: number;
    estimatedInputTokens: number;
    usageAdjustmentTokens: number;
    outputReserveTokens: number;
    safetyMarginTokens: number;
    remainingTokens: number;
  };
  usageBasis: UsageBasis;
};
export type SessionEvent =
  | { type: 'restored'; revision: number; messages: number; pendingCallIds: string[] }
  | { type: 'compaction-started'; revision: number; throughId: string }
  | { type: 'compaction-committed'; revision: number; checkpointId: string }
  | { type: 'compaction-failed'; revision: number; error: unknown }
  | { type: 'native-prepared'; revision: number; origin: 'raw' | 'resumed' | 'rebuilt'; checkpointId: string | null }
  | { type: 'native-committed'; revision: number; checkpointId: string; phase: 'compaction' | 'response' }
  | { type: 'working-memory-committed'; revision: number; checkpointId: string; activeThroughSequence: number };
