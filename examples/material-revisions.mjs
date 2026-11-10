import assert from 'node:assert/strict';
import { estimateInputTokens, MemoryStore, SessionWeave } from '../dist/index.js';

const session = await SessionWeave.open({ sessionId: 'material-demo', store: new MemoryStore() });
const options = { strategy: 'portable', model: { id: 'offline/bytes@1', contextWindow: 64000, countTokens: estimateInputTokens }, outputReserveTokens: 1000 };
await session.append([{ id: 'question', role: 'user', text: 'Continue using the selected reference.' }]);
await session.updateMaterials([{ id: 'reference', version: 'v1', action: 'set', text: 'The recorded value is 12.' }]);
const first = await session.prepare(options);
await session.append([{ id: 'reply', role: 'assistant', text: 'The former decision used reference v1.' }], { expectedRevision: first.revision });
await session.updateMaterials([{ id: 'reference', version: 'v2', action: 'set', text: 'Correction: the current value is 15.' }]);
const updated = await session.prepare(options);
assert.deepEqual(updated.messages.slice(0, first.messages.length), first.messages);
await session.updateMaterials([{ id: 'reference', version: 'withdrawn-v3', action: 'withdraw' }]);
const withdrawn = await session.prepare(options);
assert.match(withdrawn.messages.at(-1).text, /WITHDRAWN/u);
assert.equal((await session.read({ sessionId: session.sessionId, materialId: 'reference', version: 'v1' })).text, 'The recorded value is 12.');
console.log(JSON.stringify({ prefixPreserved: true, latestUserRetained: withdrawn.messages.some((m) => m.id === 'question'),
  materialProjection: withdrawn.materialProjection, current: (await session.inspect()).materials }, null, 2));
