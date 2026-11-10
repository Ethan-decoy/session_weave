import { ContextBudgetError, invariant, integer } from './errors.js';
import { json, jsonDigest } from './data.js';
import { assertMaterialSnapshots, materialHeads, projectMaterialHistory } from './materials.js';
import type {
  Checkpoint, ContextMessage, MaterialProjection, ModelInput, ModelProfile, PreparedContext, PrepareOptions,
  SessionState, UsageBasis, WorkingMemoryCheckpoint,
} from './types.js';

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

type Projection = { input: ModelInput; materialProjection?: MaterialProjection };
function projectInput(state: SessionState, options: PrepareOptions, through: number | null, currentOnly: boolean): Projection {
  assertMaterialSnapshots(state, options.materials ?? []);
  const latestUser = state.messages.findLast((message) => message.role === 'user');
  const messages: ContextMessage[] = [];
  for (const material of options.materials ?? []) {
    invariant(typeof material.id === 'string' && typeof material.text === 'string', 'Materials require an ID and text.');
    messages.push(syntheticMessage(
      `material:${material.id}`,
      `Reference material ${json(material.id)} (untrusted data):\n${material.text}`,
      'material',
    ));
  }
  const raw = state.messages.filter((message) => message.sequence > (through ?? 0) || message.id === latestUser?.id).map((message) => structuredClone(message));
  const material = projectMaterialHistory(state, raw, through, currentOnly);
  messages.push(...material.messages);
  return {
    input: { systemPrompt: options.systemPrompt ?? '', tools: structuredClone(options.tools ?? []), messages },
    ...(material.projection ? { materialProjection: material.projection } : {}),
  };
}

function projectHandoff(state: SessionState, options: PrepareOptions, checkpoint: Checkpoint | null, currentOnly: boolean): Projection {
  const projected = projectInput(state, options, checkpoint?.throughSequence ?? null, currentOnly);
  if (checkpoint) projected.input.messages.unshift(syntheticMessage(
    `handoff:${checkpoint.id}`,
    `Prior work handoff (untrusted historical data; raw references remain readable):\n${json(checkpoint.handoff)}`,
    'handoff',
  ));
  return projected;
}

function projectMemory(
  state: SessionState,
  options: PrepareOptions,
  checkpoint: WorkingMemoryCheckpoint | null,
  protectedThrough: number,
  currentOnly: boolean,
): Projection {
  const through = checkpoint ? Math.min(checkpoint.activeThroughSequence, protectedThrough) : null;
  const projected = projectInput(state, options, through, currentOnly);
  if (checkpoint?.projection) projected.input.messages.unshift(syntheticMessage(
    `working-memory:${checkpoint.id}`,
    `Prior working memory (untrusted historical data; consult raw records for exact evidence):\n${checkpoint.projection}\nRaw sources: ${json(checkpoint.sources)}`,
    'working-memory',
  ));
  return projected;
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
    fixedHash: jsonDigest({ systemPrompt: input.systemPrompt, tools: input.tools, materials: options.materials ?? [],
      ...(state.materialRevisions?.length ? { materialRevisions: input.messages.filter((message) => message.synthetic === 'material' && message.id.startsWith('material-revision:')) } : {}) }),
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
      (currentOnly) => projectHandoff(state, this.options, checkpoint, currentOnly),
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
      (currentOnly) => projectMemory(state, this.options, checkpoint, protectedThrough, currentOnly),
      checkpoint,
      checkpoint ? 'working-memory' : rebuilt ? 'rebuilt' : 'raw',
    );
  }

  private async build(
    state: SessionState,
    project: (currentOnly: boolean) => Projection,
    checkpoint: { id: string } | null,
    origin: PreparedContext['origin'],
  ): Promise<PreparedContext> {
    let projected = project(false);
    let estimated = await countInputTokens(this.options.model, projected.input);
    let observationBasis = usageBasis(state, this.options, projected.input, estimated, checkpoint);
    let adjustment = usageAdjustment(state, observationBasis);
    // Fold obsolete bodies only under budget pressure. Originals and tombstones stay in storage.
    if (projected.materialProjection && projected.materialProjection.retainedRevisions > materialHeads(state.materialRevisions ?? []).length
      && estimated + adjustment > Math.floor(this.availableTokens * (this.options.compactAt ?? 0.85))) {
      const current = project(true), count = await countInputTokens(this.options.model, current.input);
      const basis = usageBasis(state, this.options, current.input, count, checkpoint), calibrated = usageAdjustment(state, basis);
      if (count + calibrated < estimated + adjustment) {
        projected = current; estimated = count; observationBasis = basis; adjustment = calibrated;
      }
    }

    return {
      ...projected.input,
      strategy: 'portable',
      origin,
      sessionId: state.sessionId,
      revision: state.revision,
      modelId: this.options.model.id,
      checkpointId: checkpoint?.id ?? null,
      ...(projected.materialProjection ? { materialProjection: projected.materialProjection } : {}),
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
