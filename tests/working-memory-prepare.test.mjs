import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, SessionWeave } from '../dist/index.js';

const identity = { engine: 'fixture@1', codec: 'fixture@1', policy: 'fixture@1' };
const history = Array.from({ length: 8 }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? 'assistant' : 'user', text: `Original ${index + 1}` }));
const options = { strategy: 'portable', model: { id: 'actor', contextWindow: 1000,
  countTokens: (input) => input.messages.some((message) => message.synthetic === 'working-memory') ? 150 : 900 },
  outputReserveTokens: 100, safetyMarginTokens: 0, keepRecentGroups: 2 };
function engine(derive) {
  return { identity, async derive(request, signal) {
    if (derive) return derive(request, signal);
    return candidate(request);
  } };
}
function candidate(request, active = request.messages.length) {
  return { complete: true, identity, sourceRevision: request.sourceRevision, sourceThroughId: request.messages.at(-1).id,
    activeThroughId: request.messages[active - 1]?.id ?? null, engineState: { fixture: true, consumed: request.messages.length },
    projection: active ? 'Saved historical memory.' : '', sources: active ? [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.messages[active - 1].id }] : [] };
}
async function open(workingMemory = engine(), store = new MemoryStore()) {
  const session = await SessionWeave.open({ sessionId: 'prepare-memory', store, workingMemory });
  await session.append(history);
  return { session, store };
}
test('prepare counts final memory, current materials/tools/instructions and protected raw groups before one publication', async () => {
  const seen = [], { session, store } = await open();
  const raw = structuredClone((await store.load(session.sessionId)).messages);
  const prepared = await session.prepare({ ...options, systemPrompt: 'Current instruction', tools: [{ name: 'host_read' }], materials: [{ id: 'current', text: 'Current material' }],
    model: { ...options.model, countTokens(input) { seen.push(input); return options.model.countTokens(input); } } });
  assert.equal(prepared.origin, 'working-memory');
  assert.equal(prepared.systemPrompt, 'Current instruction');
  assert.deepEqual(prepared.tools, [{ name: 'host_read' }]);
  assert.ok(prepared.messages.some((message) => message.synthetic === 'material' && message.text.includes('Current material')));
  assert.deepEqual(prepared.messages.filter((message) => !message.synthetic).map((message) => message.id), ['m7', 'm8']);
  assert.ok(prepared.messages[0].id.endsWith(prepared.checkpointId));
  assert.equal(prepared.usageBasis.checkpointId, prepared.checkpointId);
  assert.equal(prepared.revision, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual((await store.load(session.sessionId)).messages, raw);
});
test('buffered source stays raw after activeThrough and latest user survives an already-covered range', async () => {
  const { session } = await open(engine((request) => candidate(request, 2)));
  const prepared = await session.prepare(options);
  assert.deepEqual(prepared.messages.filter((message) => !message.synthetic).map((message) => message.id), ['m3', 'm4', 'm5', 'm6', 'm7', 'm8']);
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: prepared.checkpointId });
  assert.equal(checkpoint.sourceThroughSequence, 6);
  assert.equal(checkpoint.activeThroughSequence, 2);
  const state = await session.inspect();
  await session.publishWorkingMemory({ ...candidate({ sessionId: session.sessionId, sourceRevision: state.revision, messages: (await session.read({ sessionId: session.sessionId, startId: 'm1', endId: 'm8' })) }), engineState: { fixture: true } });
  const reused = await session.prepare({ ...options, keepRecentGroups: 1 });
  assert.deepEqual(reused.messages.filter((message) => !message.synthetic).map((message) => message.id), ['m7', 'm8']);
});
test('a saved projection is reusable after reopening without generation, with checkpoint-scoped usage', async () => {
  let derives = 0;
  const memory = engine((request) => { derives++; return candidate(request); });
  const { session, store } = await open(memory), first = await session.prepare(options);
  await session.append([{ id: 'reply', role: 'assistant', text: 'Actual response' }], { expectedRevision: first.revision, usage: { basis: first.usageBasis, inputTokens: 180, outputTokens: 10 } });
  const reopened = await SessionWeave.open({ sessionId: session.sessionId, store });
  const second = await reopened.prepare(options);
  assert.equal(second.checkpointId, first.checkpointId);
  assert.equal(second.budget.usageAdjustmentTokens, 30);
  assert.equal(derives, 1);
});
test('final budget failure and cancellation do not activate a generated candidate', async () => {
  for (const mode of ['budget', 'cancel']) {
    const controller = new AbortController();
    const { session, store } = await open(engine((request) => { if (mode === 'cancel') controller.abort(); return candidate(request); }));
    const before = await store.load(session.sessionId);
    await assert.rejects(session.prepare({ ...options, signal: controller.signal,
      ...(mode === 'budget' ? { model: { ...options.model, countTokens: () => 999 } } : {}) }), (error) => mode === 'budget' ? error.code === 'CONTEXT_BUDGET' : error.name === 'AbortError');
    assert.deepEqual(await store.load(session.sessionId), before);
  }
});
test('new input during derivation or final counting wins against the old candidate', async () => {
  for (const stage of ['derive', 'count']) {
    let session;
    const fixture = await open(engine(async (request) => { if (stage === 'derive') await session.append([{ id: 'arrived', role: 'user', text: 'Concurrent input' }]); return candidate(request); }));
    session = fixture.session;
    await assert.rejects(session.prepare({ ...options, model: { ...options.model, async countTokens(input) {
      if (stage === 'count' && input.messages.some((message) => message.synthetic === 'working-memory')) await session.append([{ id: 'arrived', role: 'user', text: 'Concurrent input' }]);
      return options.model.countTokens(input);
    } } }), (error) => error.code === 'REVISION_CONFLICT');
    const state = await fixture.store.load(session.sessionId);
    assert.equal(state.messages.at(-1).id, 'arrived');
    assert.equal(state.workingMemoryCheckpoints?.length ?? 0, 0);
  }
});
test('identity changes rebuild from raw instead of reinterpreting a previous engine bundle', async () => {
  const { session, store } = await open(), first = await session.prepare(options);
  let request;
  const nextIdentity = { ...identity, policy: 'changed@2' };
  const reopened = await SessionWeave.open({ sessionId: session.sessionId, store, workingMemory: { identity: nextIdentity, async derive(value) {
    request = value; return { ...candidate(value), identity: nextIdentity };
  } } });
  const prepared = await reopened.prepare({ ...options, model: { ...options.model, countTokens: (input) => input.messages.some((message) => message.synthetic) ? 150 : 900 } });
  assert.equal(request.previous, null);
  assert.equal(request.messages[0].id, 'm1');
  assert.notEqual(prepared.checkpointId, first.checkpointId);
});
