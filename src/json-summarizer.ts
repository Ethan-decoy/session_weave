import { invariant } from './errors.js';
import type { ModelInput, ModelProfile, Summarizer, SummaryResult } from './types.js';

/** The host supplies authentication/transport; only complete JSON responses can become candidates. */
export function createJsonSummarizer(options: {
  model: ModelProfile;
  outputReserveTokens: number;
  generate(input: ModelInput, options: { maxOutputTokens: number; signal?: AbortSignal }): Promise<{ text: string; complete: boolean }>;
}): Summarizer {
  return {
    model: options.model, outputReserveTokens: options.outputReserveTokens,
    async summarize(request, signal) {
      signal?.throwIfAborted();
      const result = await options.generate(request.input, { maxOutputTokens: request.maxOutputTokens, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      invariant(result.complete === true, 'Summary model response was interrupted or truncated.');
      return JSON.parse(result.text) as SummaryResult;
    },
  };
}
