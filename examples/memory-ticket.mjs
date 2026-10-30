import assert from 'node:assert/strict';
import { SessionWeave, MemoryStore, estimateInputTokens } from '../dist/index.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOfflineOmModel } from './om-fixture.mjs';

// The fixed-prefix candidate may finish after another user arrives. It publishes nothing.
let session;
const model = createOfflineOmModel({ async onCall({ index }) {
  if (index === 1) await session.append([{ id: 'current-user', role: 'user', text: 'A newer request, with its own current instructions.' }]);
} });
const store = new MemoryStore();
const workingMemory = createOmWorkingMemory({ model, modelId: 'ticket-example/offline@1' });
session = await SessionWeave.open({ sessionId: 'fixed-prefix-example', store, workingMemory });
await session.append(Array.from({ length: 8 }, (_, index) => ({ id: `original-${index + 1}`, role: index % 2 ? 'assistant' : 'user', text: `Historical evidence ${index + 1}.` })));
const ticket = await session.precomputeWorkingMemory({ throughId: 'original-4' });
assert.equal((await session.inspect()).workingMemoryCheckpoint, null);
// The host chooses this new request boundary and discards any obsolete actor request.
const options = { strategy: 'portable', model: { id: 'current-actor/byte-estimate@1', contextWindow: 5000, countTokens: estimateInputTokens },
  systemPrompt: 'Current instructions for the newer user.', materials: [{ id: 'current', text: 'Current request material.' }], outputReserveTokens: 400 };
const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: context.checkpointId });
assert.equal(checkpoint.sourceRevision, 1);
assert.equal(checkpoint.publishedFromRevision, 2);
assert.equal(context.revision, 3);
assert.ok(context.messages.some((message) => message.id === 'current-user'));
const reopened = await SessionWeave.open({ sessionId: session.sessionId, store, workingMemory });
const reused = await reopened.prepare(options);
assert.equal(reused.checkpointId, context.checkpointId);
assert.equal(model.calls.length, 1);
console.log(JSON.stringify({ sourceRevision: checkpoint.sourceRevision, publishedFromRevision: checkpoint.publishedFromRevision,
  returnedRevision: context.revision, processedThrough: checkpoint.sourceThroughId, sourceMessages: checkpoint.provenance.sourceMessageCount,
  publishedMessages: checkpoint.publishedMessageCount, generationCalls: model.calls.length, currentUserIncluded: true, checkpointVersion: checkpoint.version }, null, 2));
