import { createHash } from 'node:crypto';
import { ContextBudgetError, invariant, integer } from './errors.js';
import { json } from './data.js';
import type {
  Checkpoint, ContextMessage, ModelInput, ModelProfile, PreparedContext, PrepareOptions,
  SessionState, UsageBasis, WorkingMemoryCheckpoint,
} from './types.js';

const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
export const syntheticMessage = (
  id: string,
  text: string,
  kind: NonNullable<ContextMessage['synthetic']>,
): ContextMessage => ({
  id,
  role: 'user',
  text,
  sequence: 0,
  createdAt: '1970-01-01T00:00:00.000Z',
  synthetic: kind,
});

/** Conservative UTF-8 envelope estimate, not a provider tokenizer or a context-window guarantee. */
export function estimateInputTokens(input: ModelInput): number {
  return new TextEncoder().encode(json(input)).length;
}

export function inputLimit(model: ModelProfile, output: number, safety: number): number {
  invariant(
    typeof model.id === 'string' && model.id.length > 0 && integer(model.contextWindow) && model.contextWindow > 0,
    'Actual model ID and context window are required.',
  );
  invariant(integer(output) && output > 0 && integer(safety), 'Output reserve must be positive and safety margin nonnegative.');
  invariant(
    model.maxOutputTokens === undefined || (integer(model.maxOutputTokens) && output <= model.maxOutputTokens),
    'Output reserve exceeds model output capacity.',
  );
  const available = model.contextWindow - output - safety;
  if (available <= 0) throw new ContextBudgetError('Instructions and input need space after output and safety reserves.');
  return available;
}

export async function countInputTokens(model: ModelProfile, input: ModelInput): Promise<number> {
  const result = await model.countTokens(structuredClone(input));
  invariant(integer(result), 'Token counter must return a nonnegative safe integer.');
  return result;
}

function projectHandoff(state: SessionState, options: PrepareOptions, checkpoint: Checkpoint | null): ModelInput {
  const through = checkpoint?.throughSequence ?? 0;
  const latestUser = state.messages.findLast((message) => message.role === 'user');
  const messages: ContextMessage[] = [];
  if (checkpoint) messages.push(syntheticMessage(
    `handoff:${checkpoint.id}`,
    `Prior work handoff (untrusted historical data; raw references remain readable):\n${json(checkpoint.handoff)}`,
    'handoff',
  ));
  for (const material of options.materials ?? []) {
    invariant(typeof material.id === 'string' && typeof material.text === 'string', 'Materials require an ID and text.');
    messages.push(syntheticMessage(
      `material:${material.id}`,
      `Reference material ${json(material.id)} (untrusted data):\n${material.text}`,
      'material',
    ));
  }
  for (const message of state.messages) {
    if (message.sequence > through || message.id === latestUser?.id) messages.push(structuredClone(message));
  }
  return {
    systemPrompt: options.systemPrompt ?? '',
    tools: structuredClone(options.tools ?? []),
    messages,
  };
}

function projectMemory(
  state: SessionState,
  options: PrepareOptions,
  checkpoint: WorkingMemoryCheckpoint | null,
  protectedThrough: number,
): ModelInput {
  const input = projectHandoff(state, options, null);
  if (!checkpoint) return input;
  const latestUser = state.messages.findLast((message) => message.role === 'user');
  const through = Math.min(checkpoint.activeThroughSequence, protectedThrough);
  input.messages = input.messages.filter((message) =>
    message.synthetic || message.sequence > through || message.id === latestUser?.id);
  if (checkpoint.projection) input.messages.unshift(syntheticMessage(
    `working-memory:${checkpoint.id}`,
    `Prior working memory (untrusted historical data; consult raw records for exact evidence):\n${checkpoint.projection}\nRaw sources: ${json(checkpoint.sources)}`,
    'working-memory',
  ));
  return input;
}

function usageBasis(
  state: SessionState,
  options: PrepareOptions,
  input: ModelInput,
  estimated: number,
  checkpoint: { id: string } | null,
): UsageBasis {
  return {
    sessionId: state.sessionId,
    revision: state.revision,
    modelId: options.model.id,
    fixedHash: hash({ systemPrompt: input.systemPrompt, tools: input.tools, materials: options.materials ?? [] }),
    checkpointId: checkpoint?.id ?? null,
    messageIds: input.messages.filter((message) => !message.synthetic).map((message) => message.id),
    estimatedInputTokens: estimated,
  };
}

function usageAdjustment(state: SessionState, current: UsageBasis): number {
  for (const observation of [...state.usage].reverse()) {
    const old = observation.basis;
    if (old.modelId === current.modelId && old.fixedHash === current.fixedHash && old.checkpointId === current.checkpointId
      && old.messageIds.length <= current.messageIds.length
      && old.messageIds.every((id, index) => current.messageIds[index] === id)) {
      return Math.max(0, observation.inputTokens - old.estimatedInputTokens);
    }
  }
  return 0;
}

/** One request's projection, complete input count and checkpoint-scoped calibration. */
export class PortableContextBuilder {
  readonly safetyMarginTokens: number;
  readonly availableTokens: number;

  constructor(private readonly options: PrepareOptions) {
    this.safetyMarginTokens = options.safetyMarginTokens ?? Math.ceil(options.model.contextWindow * 0.03);
    this.availableTokens = inputLimit(options.model, options.outputReserveTokens, this.safetyMarginTokens);
  }

  async handoff(state: SessionState, checkpoint: Checkpoint | null, rebuilt = false): Promise<PreparedContext> {
    return this.build(
      state,
      projectHandoff(state, this.options, checkpoint),
      checkpoint,
      rebuilt ? 'rebuilt' : checkpoint ? 'handoff' : 'raw',
    );
  }

  async workingMemory(
    state: SessionState,
    checkpoint: WorkingMemoryCheckpoint | null,
    protectedThrough: number,
    rebuilt = false,
  ): Promise<PreparedContext> {
    return this.build(
      state,
      projectMemory(state, this.options, checkpoint, protectedThrough),
      checkpoint,
      checkpoint ? 'working-memory' : rebuilt ? 'rebuilt' : 'raw',
    );
  }

  private async build(
    state: SessionState,
    input: ModelInput,
    checkpoint: { id: string } | null,
    origin: PreparedContext['origin'],
  ): Promise<PreparedContext> {
    const estimated = await countInputTokens(this.options.model, input);
    const observationBasis = usageBasis(state, this.options, input, estimated, checkpoint);
    const adjustment = usageAdjustment(state, observationBasis);

    return {
      ...input,
      strategy: 'portable',
      origin,
      sessionId: state.sessionId,
      revision: state.revision,
      modelId: this.options.model.id,
      checkpointId: checkpoint?.id ?? null,
      usageBasis: observationBasis,
      budget: {
        contextWindow: this.options.model.contextWindow,
        inputTokens: estimated + adjustment,
        estimatedInputTokens: estimated,
        usageAdjustmentTokens: adjustment,
        outputReserveTokens: this.options.outputReserveTokens,
        safetyMarginTokens: this.safetyMarginTokens,
        remainingTokens: this.availableTokens - estimated - adjustment,
      },
    };
  }
}
