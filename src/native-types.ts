import type { Json, Message, MessageInput, PrepareOptions } from './types.js';

export type JsonObject = { [key: string]: Json };
/** Actual selected deployment identity, not inferred from a model brand or compatible wire format. */
export type NativeBinding = {
  provider: string;
  endpoint: string;
  model: string;
  apiVersion: string;
  scope: string;
  protocol: string;
  capability: string;
};
export type NativeBackend = Omit<NativeBinding, 'protocol' | 'capability'>;
export type NativeRequest = { body: JsonObject; headers: Record<string, string> };
export type NativeTransport = (request: NativeRequest, signal?: AbortSignal) => Promise<unknown>;
export type NativeBuildInput = {
  messages: Message[];
  state: JsonObject | null;
  systemPrompt: string;
  tools: Json[];
  materials: { id: string; text: string }[];
  outputReserveTokens: number;
};
export type NativeResult = { state: JsonObject; messages: MessageInput[]; portableComplete: boolean; responseId: string };
export type NativeCompactionResult = { state: JsonObject; request: NativeRequest; response: Json; responseId: string };
export interface NativeAdapter {
  readonly binding: NativeBinding;
  readonly mode: 'on-demand' | 'server-threshold';
  readonly thresholdTokens?: number;
  build(input: NativeBuildInput): NativeRequest;
  /** Count effective provider input, including opaque state; never count ciphertext as ordinary text. */
  countTokens(request: NativeRequest, previousResponse?: Json): number | Promise<number>;
  send: NativeTransport;
  compact?: (request: NativeRequest, signal?: AbortSignal) => Promise<NativeCompactionResult>;
  accept(request: NativeRequest, response: unknown): NativeResult;
}
export type NativeCapability =
  | { status: 'unknown'; reason: string }
  | { status: 'unsupported'; binding: NativeBinding; evidence: string }
  | { status: 'supported'; binding: NativeBinding; evidence: string; adapter: NativeAdapter };
export type CompactionStrategy = 'auto' | 'native' | 'portable';
export type NativeCheckpoint = {
  id: string;
  createdAt: string;
  sourceRevision: number;
  previousId: string | null;
  binding: NativeBinding;
  fixedHash: string;
  phase: 'compaction' | 'response';
  origin: 'raw' | 'resumed' | 'rebuilt';
  baseSequence: number;
  throughSequence: number;
  throughId: string;
  publicMessageIds: string[];
  portableComplete: boolean;
  request: NativeRequest;
  response: Json;
  responseId: string;
  state: JsonObject;
};
export type NativePreparedContext = {
  strategy: 'native';
  id: string;
  sessionId: string;
  revision: number;
  modelId: string;
  binding: NativeBinding;
  checkpointId: string | null;
  origin: 'raw' | 'resumed' | 'rebuilt';
  rebuildReason?: string;
  request: NativeRequest;
  budget: { contextWindow: number; inputTokens: number; outputReserveTokens: number; safetyMarginTokens: number; remainingTokens: number };
};
export type RuntimePrepareOptions = {
  runtime: { id: string; sessionId: string; capabilities: { persistentSessions: boolean; compaction: boolean }; evidence: string };
  signal?: AbortSignal;
};
export type RuntimePlan = {
  strategy: 'runtime'; sessionId: string; revision: number;
  delegate: { id: string; sessionId: string };
};
export type NativeReceipt = { revision: number; messageIds: string[]; nativeCheckpointId: string; responseId: string; replayed: boolean };
export type NativePlan = {
  adapter: NativeAdapter;
  binding: NativeBinding;
  fixedHash: string;
  context: NativePreparedContext;
  requestHash: string;
  before: NativeCheckpoint | undefined;
  portableComplete: boolean;
  responseHash?: string;
  receipt?: NativeReceipt;
};
export type NativePreparation = { context: NativePreparedContext; plan: NativePlan };
export type NativePrepareOptions = PrepareOptions;
