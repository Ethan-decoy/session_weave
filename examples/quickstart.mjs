// Offline demonstration only: the deterministic generator is not an AI quality demonstration.
import { SessionWeave, createJsonSummarizer, estimateInputTokens } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';

const summarizer = createJsonSummarizer({
  model: { id: 'offline-demo-summary', contextWindow: 64000, countTokens: estimateInputTokens },
  outputReserveTokens: 4000,
  async generate(input) {
    const request = JSON.parse(input.messages[0].text);
    return { complete: true, text: JSON.stringify({ complete: true, throughId: request.throughId, handoff: {
      version: 1,
      goals: [{ text: 'Continue the offline session example.', refs: [{
        sessionId: request.sessionId, startId: request.previous?.goals[0]?.refs[0]?.startId ?? request.messages[0].id, endId: request.throughId,
      }] }], constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [],
    } }) };
  },
});
const session = await SessionWeave.open({
  sessionId: 'quickstart-explicit-session', store: new FileStore('.sessionweave/quickstart'), summarizer,
});
for (let index = 0; index < 8; index++) await session.append([
  { id: `user-${index}`, role: 'user', text: `Question ${index}: ${'context '.repeat(24)}` },
  { id: `reply-${index}`, role: 'assistant', text: `Public reply ${index}: ${'result '.repeat(24)}` },
]);
const context = await session.prepare({
  model: { id: 'offline-demo-target', contextWindow: 3000, countTokens: estimateInputTokens }, outputReserveTokens: 300,
});
const original = await session.read({ sessionId: session.sessionId, startId: 'user-0', endId: 'reply-0' });
console.log(JSON.stringify({
  sessionId: session.sessionId, rawMessages: (await session.inspect()).messageCount,
  checkpointId: context.checkpointId, activeMessages: context.messages.length, budget: context.budget,
  recoveredOriginalIds: original.map((message) => message.id),
}, null, 2));
