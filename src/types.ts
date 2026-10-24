export type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };
export type ToolCall = { id: string; name: string; arguments: { [key: string]: Json } };
export type MessageInput = (
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; text: string; isError: boolean }
) & { id?: string };
export type Message = MessageInput & { id: string; sequence: number; createdAt: string };
export type Reference = { sessionId: string; startId: string; endId: string };
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
export type ContextMessage = Message & { synthetic?: 'handoff' | 'material' };
export type ModelInput = { systemPrompt: string; tools: Json[]; messages: ContextMessage[] };
export type ModelProfile = {
  /** Include provider, model and tokenizer revision; usage observations are scoped to this key. */
  id: string;
  contextWindow: number;
  maxOutputTokens?: number;
  countTokens(input: ModelInput): number | Promise<number>;
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
  version: 1;
  sessionId: string;
  revision: number;
  messages: Message[];
  checkpoints: Checkpoint[];
  usage: UsageObservation[];
};
export type Mutation = { messages?: Message[]; checkpoint?: Checkpoint; usage?: UsageObservation };
/** Must atomically compare revision and append only; never mutate existing raw records. */
export interface SessionStore {
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
  | { type: 'compaction-failed'; revision: number; error: unknown };
