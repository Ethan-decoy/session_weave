// Offline wire fixtures and fixed token counts: this checks engineering, not a provider or summary quality.
import assert from 'node:assert/strict';
import { SessionWeave } from 'sessionweave';
import { FileStore } from 'sessionweave/file-store';
import { createOpenAINativeAdapter, confirmedNativeCapability } from 'sessionweave/native';

let compactionCalls = 0, generationCalls = 0;
const opaque = { type: 'compaction', id: 'fixture-compaction-item', encrypted_content: 'offline-opaque-state-exactly-preserved' };
const adapter = createOpenAINativeAdapter({
  backend: { provider: 'offline-fixture', endpoint: 'https://offline.invalid/v1', model: 'fixture-model', apiVersion: 'fixture-v1', scope: 'offline-example' },
  mode: 'on-demand',
  countTokens: (request) => request.body.input.some((item) => item.type === 'compaction') ? 20 : 950,
  compact: async (request) => {
    compactionCalls++;
    return { id: 'fixture-compact-response', object: 'response.compaction', output: [...request.body.input, opaque] };
  },
  generate: async () => {
    generationCalls++;
    return { id: 'fixture-public-response', status: 'completed', output: [
      { type: 'reasoning', encrypted_content: 'offline-reasoning-state', summary: [] },
      { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline native continuation recorded.', annotations: [] }] },
    ], usage: { input_tokens: 20, output_tokens: 12 } };
  },
});
const prepareOptions = {
  model: { id: 'offline-native-fixture-v1', contextWindow: 1200, maxOutputTokens: 100,
    backend: adapter.binding,
    nativeCompaction: confirmedNativeCapability(adapter, 'Offline fixture only; no real deployment capability is asserted.'),
    countTokens: () => { throw new Error('Portable counting must not receive native state'); },
  },
  outputReserveTokens: 100,
};
const store = new FileStore('.sessionweave/native-roundtrip');
const sessionId = 'native-roundtrip-explicit-id';
const session = await SessionWeave.open({ sessionId, store });
await session.append([{ id: 'fixture-user', role: 'user', text: 'Keep this original question available for readback.' }]);
const initial = await session.inspect();
const latest = initial.nativeCheckpoint
  ? await session.read({ sessionId, nativeCheckpointId: initial.nativeCheckpoint.id }) : null;
if (latest?.phase !== 'response') {
  const context = await session.prepare(prepareOptions);
  assert.equal(context.strategy, 'native');
  await session.accept(context, await adapter.send(context.request));
}

const callsBeforeRestore = compactionCalls + generationCalls;
const restored = await SessionWeave.open({ sessionId, store: new FileStore('.sessionweave/native-roundtrip') });
const status = await restored.inspect();
const artifact = await restored.read({ sessionId, nativeCheckpointId: status.nativeCheckpoint.id });
const resumed = await restored.prepare(prepareOptions);
assert.equal(resumed.strategy, 'native');
assert.equal(resumed.origin, 'resumed');
assert.deepEqual(resumed.request.body.input, artifact.state.input);
assert.equal(compactionCalls + generationCalls, callsBeforeRestore);
assert.equal(status.messageCount, 2);
assert.deepEqual(status.pendingCallIds, []);
const original = await restored.read({ sessionId, startId: 'fixture-user', endId: 'fixture-user' });
assert.equal(original[0].text, 'Keep this original question available for readback.');
console.log(JSON.stringify({
  transport: 'offline-fixture', strategy: resumed.strategy, origin: resumed.origin,
  rawMessages: status.messageCount, nativeCheckpointId: artifact.id,
  compactionCalls, generationCalls, restoreCalls: compactionCalls + generationCalls - callsBeforeRestore,
  fullWindowPreserved: true, originalReadback: original.map((message) => message.id),
}, null, 2));
