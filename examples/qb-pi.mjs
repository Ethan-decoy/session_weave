// Host supplies Pi AI complete(), authenticated models, tokenizer and its existing storage.
// This is the explicit portable path. Native compaction uses a raw protocol adapter instead.
// This module does not import the complete Pi Agent and never executes domain tools.
import { SessionWeave, createJsonSummarizer } from '../dist/index.js';
import { fromPiAssistant, piModelProfile, piUsage, toPiContext } from '../dist/pi.js';

export async function openResearchSession({ sessionId, store, summaryModel, countTokens, complete, onEvent }) {
  const summarizer = createJsonSummarizer({
    model: piModelProfile(summaryModel, (input) => countTokens(summaryModel, input)),
    outputReserveTokens: Math.min(4000, summaryModel.maxTokens),
    async generate(input, { maxOutputTokens, signal }) {
      const response = await complete(summaryModel, toPiContext(input, summaryModel, []), { maxTokens: maxOutputTokens, signal });
      return {
        complete: response.stopReason === 'stop',
        text: response.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
      };
    },
  });
  return SessionWeave.open({ sessionId, store, summarizer, onEvent });
}

export async function requestModelStep(session, {
  model, tools = [], systemPrompt = '', materials = [], outputReserveTokens,
  countTokens, complete, signal, responseMessageId, strategy,
}) {
  if (strategy !== 'portable') throw new Error('The Pi text bridge requires an explicit portable strategy; use a raw native adapter for native state.');
  const context = await session.prepare({
    strategy,
    model: piModelProfile(model, (input) => countTokens(model, input)),
    // Remove schema-only symbols; the serialized declarations must match what is sent.
    tools: JSON.parse(JSON.stringify(tools)), systemPrompt, materials, outputReserveTokens, signal,
  });
  const response = await complete(model, toPiContext(context, model, tools), { maxTokens: outputReserveTokens, signal });
  signal?.throwIfAborted();
  const message = fromPiAssistant(response, responseMessageId);
  const receipt = await session.append([message], { expectedRevision: context.revision, usage: piUsage(context, response) });
  // Only after this succeeds should the host execute these calls, using its own idempotency rules.
  return { context, message, receipt };
}
