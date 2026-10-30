import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SessionWeave, estimateInputTokens } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOfflineOmModel } from './om-fixture.mjs';

// The real published OM engine runs against this offline SDK fixture.
// Supply your own explicit SDK model and a stable model/settings identity in a host app.
const model = createOfflineOmModel();
const workingMemory = createOmWorkingMemory({ model, modelId: 'offline-example/settings@1' });
const store = new FileStore(fileURLToPath(new URL('../.sessionweave/om-example/', import.meta.url)));
const sessionId = 'om-explicit-session';
let session = await SessionWeave.open({ sessionId, store, workingMemory });
const messages = Array.from({ length: 12 }, (_, index) => ({ id: `om-${index + 1}`, role: index % 2 ? 'assistant' : 'user',
  text: `Recorded evidence ${index + 1}. ${'Original detail remains readable. '.repeat(18)}` }));
const options = { strategy: 'portable', model: { id: 'offline-byte-estimate@1', contextWindow: 4000, countTokens: estimateInputTokens },
  systemPrompt: 'Use the current task and consult raw evidence for exact details.', tools: [],
  materials: [{ id: 'current', text: 'This material belongs to the current request.' }], outputReserveTokens: 400, keepRecentGroups: 2 };
await session.append(messages.slice(0, 8));
await session.prepare(options);
await session.append(messages.slice(8));
const prepared = await session.prepare(options);
assert.equal(prepared.origin, 'working-memory');
const before = model.calls.length;
session = await SessionWeave.open({ sessionId, store, workingMemory });
const resumed = await session.prepare(options);
assert.equal(resumed.checkpointId, prepared.checkpointId);
assert.equal(model.calls.length, before);
const checkpoint = await session.read({ sessionId, workingMemoryCheckpointId: resumed.checkpointId });
const original = await session.read({ sessionId, startId: 'om-1', endId: 'om-12' });
assert.equal(original.length, 12);
console.log(JSON.stringify({ transport: 'offline-sdk-fixture', origin: resumed.origin, rawMessages: original.length,
  activeThroughSequence: checkpoint.activeThroughSequence, checkpointId: resumed.checkpointId,
  observationOrReflectionCalls: model.calls.length, callsDuringReopen: model.calls.length - before, budget: resumed.budget }, null, 2));
