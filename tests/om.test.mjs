import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOfflineOmModel } from '../examples/om-fixture.mjs';
import { temporaryDirectory } from './helpers/temporary-directory.mjs';

const raw = Array.from({ length: 8 }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? 'assistant' : 'user', text: `Evidence identifier-${index + 1}` }));
const options = { strategy: 'portable', model: { id: 'actor', contextWindow: 1000, countTokens: (input) => input.messages.some((message) => message.synthetic === 'working-memory') ? 200 : 950 },
  outputReserveTokens: 100, safetyMarginTokens: 0, keepRecentGroups: 2 };
function memory(model, extra = {}) { return createOmWorkingMemory({ model, modelId: 'fixture/settings@1', ...extra }); }
async function open(model, store = new MemoryStore(), extra = {}) {
  const session = await SessionWeave.open({ sessionId: 'actual-om', store, workingMemory: memory(model, extra) });
  await session.append(raw);
  return { session, store };
}
test('real published OM runner produces a complete restorable checkpoint and incremental observations', async () => {
  const model = createOfflineOmModel(), { session, store } = await open(model);
  const first = await session.prepare(options);
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: first.checkpointId });
  assert.equal(model.calls.length, 1);
  assert.match(checkpoint.projection, /Offline fixture memory 1/);
  assert.equal(checkpoint.engineState.bundle.value.records.length, 1);
  assert.ok(checkpoint.engineState.bundle.dates.length > 0);
  assert.ok(checkpoint.engineState.bundle.value.messages.some((message) => message.content.parts.some((part) => part.type.startsWith('data-om-'))));
  assert.equal(checkpoint.engineState.mapping.length, 6);
  const reopened = await SessionWeave.open({ sessionId: session.sessionId, store, workingMemory: memory(model) });
  const reused = await reopened.prepare(options);
  assert.equal(reused.checkpointId, first.checkpointId);
  assert.equal(model.calls.length, 1);
  await reopened.append([{ id: 'm9', role: 'user', text: 'Evidence identifier-9' }, { id: 'm10', role: 'assistant', text: 'Evidence identifier-10' }]);
  const next = await reopened.prepare({ ...options, model: { ...options.model, countTokens: (input) => input.messages.some((message) => message.text.includes('Offline fixture memory 2')) ? 200 : 800 } });
  assert.notEqual(next.checkpointId, first.checkpointId);
  assert.equal(model.calls.length, 2);
  const prompt = JSON.stringify(model.calls[1]);
  assert.match(prompt, /Offline fixture memory 1/);
  assert.match(prompt, /identifier-7/);
  assert.match(prompt, /identifier-8/);
  assert.doesNotMatch(prompt, /Evidence identifier-1/);
  assert.deepEqual(await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: first.checkpointId }), checkpoint);
});
test('same-millisecond and backward new timestamps are observed by SW sequence without changing raw timestamps', async () => {
  const model = createOfflineOmModel(), store = new MemoryStore();
  const stamp = '2026-01-01T00:00:00.000Z';
  await store.commit('actual-om', 0, { messages: raw.map((message, index) => ({ ...message, sequence: index + 1, createdAt: index === 7 ? '2025-01-01T00:00:00.000Z' : stamp })) });
  const session = await SessionWeave.open({ sessionId: 'actual-om', store, workingMemory: memory(model) });
  const first = await session.prepare(options);
  await session.append([{ id: 'm9', role: 'user', text: 'More evidence' }, { id: 'm10', role: 'assistant', text: 'More response' }]);
  await session.prepare({ ...options, model: { ...options.model, countTokens: (input) => input.messages.some((message) => message.text.includes('Offline fixture memory 2')) ? 200 : 800 } });
  assert.equal(model.calls.length, 2);
  assert.match(JSON.stringify(model.calls[1]), /identifier-7/);
  assert.equal((await store.load(session.sessionId)).messages[6].createdAt, stamp);
  assert.equal((await store.load(session.sessionId)).messages[7].createdAt, '2025-01-01T00:00:00.000Z');
  assert.equal(first.origin, 'working-memory');
});
test('manual real Reflector keeps the complete generation chain and resumes its new head', async () => {
  const model = createOfflineOmModel(), { session, store } = await open(model);
  const first = await session.prepare(options);
  const next = await session.prepare({ ...options, model: { ...options.model, countTokens: (input) => input.messages.some((message) => message.text.includes('Offline fixture memory 2')) ? 200 : 950 } });
  const saved = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: next.checkpointId });
  assert.equal(model.calls.length, 2);
  assert.equal(saved.engineState.bundle.value.records.length, 2);
  assert.equal(saved.previousId, first.checkpointId);
  assert.ok(saved.engineState.bundle.value.records.some((record) => record.supersededBy));
  const reopened = await SessionWeave.open({ sessionId: session.sessionId, store, workingMemory: memory(model) });
  await reopened.prepare(options);
  assert.equal(model.calls.length, 2);
});
test('large tool outputs fail explicitly before OM provider execution and keep raw history', async () => {
  const model = createOfflineOmModel(), { session, store } = await open(model, new MemoryStore(), { maxBatchTokens: 1_000_000 });
  await session.append([{ id: 'call', role: 'assistant', text: '', toolCalls: [{ id: 'host-call', name: 'read', arguments: { path: 'source' } }] },
    { id: 'result', role: 'tool', name: 'read', callId: 'host-call', text: 'unique result evidence '.repeat(12_000), isError: false },
    { id: 'later', role: 'user', text: 'Next' }, { id: 'tail', role: 'assistant', text: 'Tail' }]);
  const before = await store.load(session.sessionId);
  await assert.rejects(session.prepare(options), (error) => error.code === 'OM_INPUT_TOO_LARGE');
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await store.load(session.sessionId), before);
});
test('actual formatter receives text, JSON arguments and paired error outcomes', async () => {
  const model = createOfflineOmModel(), { session } = await open(model);
  await session.append([{ id: 'call', role: 'assistant', text: 'Read evidence', toolCalls: [{ id: 'host-call', name: 'host_read', arguments: { path: '/exact/source', nested: { value: 12 } } }] },
    { id: 'result', role: 'tool', name: 'host_read', callId: 'host-call', text: 'FILE_NOT_FOUND exact-file', isError: true },
    { id: 'later', role: 'user', text: 'Next' }, { id: 'tail', role: 'assistant', text: 'Tail' }]);
  await session.prepare(options);
  const prompt = JSON.stringify(model.calls[0]);
  assert.match(prompt, /host_read/);
  assert.match(prompt, /exact\/source/);
  assert.match(prompt, /FILE_NOT_FOUND/);
});
test('cancellation and new raw input during the real OM call do not publish a candidate', async () => {
  for (const mode of ['cancel', 'conflict']) {
    const controller = new AbortController();
    let session;
    const model = createOfflineOmModel({ async onCall() { if (mode === 'cancel') controller.abort(); else await session.append([{ id: 'arrival', role: 'user', text: 'New evidence' }]); } });
    const fixture = await open(model); session = fixture.session;
    await assert.rejects(session.prepare({ ...options, signal: controller.signal }), (error) => mode === 'cancel' ? error.name === 'AbortError' : error.code === 'REVISION_CONFLICT');
    assert.equal((await fixture.store.load(session.sessionId)).workingMemoryCheckpoints?.length ?? 0, 0);
  }
});
test('bounded real OM batches cover every closed group and reject an oversized indivisible group', async () => {
  const model = createOfflineOmModel(), { session } = await open(model, new MemoryStore(), { maxBatchTokens: 40 });
  const prepared = await session.prepare(options);
  assert.ok(model.calls.length > 1);
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: prepared.checkpointId });
  assert.equal(checkpoint.activeThroughSequence, 6);
  const prompts = model.calls.map((prompt) => JSON.stringify(prompt)).join('\n');
  for (let index = 1; index <= 6; index++) assert.match(prompts, new RegExp(`identifier-${index}`));
  const smaller = await open(createOfflineOmModel(), new MemoryStore(), { maxBatchTokens: 1 });
  await assert.rejects(smaller.session.prepare(options), (error) => error.code === 'OM_INPUT_TOO_LARGE');
});
test('the JSON date codec preserves ordinary ISO metadata and rejects unfinished engine state before calling the model', async () => {
  const model = createOfflineOmModel(), { session } = await open(model);
  const first = await session.prepare(options);
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: first.checkpointId });
  const messages = await session.read({ sessionId: session.sessionId, startId: 'm1', endId: 'm8' });
  const iso = '2026-01-01T00:00:00.000Z';
  checkpoint.engineState.bundle.value.thread.metadata.application = { dateAsText: iso };
  const next = await memory(model).derive({ sessionId: session.sessionId, sourceRevision: first.revision, messages, previous: checkpoint, reflow: false });
  assert.equal(next.engineState.bundle.value.thread.metadata.application.dateAsText, iso);
  assert.ok(!next.engineState.bundle.dates.some((entry) => entry.at(-1) === 'dateAsText'));
  const before = model.calls.length;
  checkpoint.engineState.bundle.value.records[0].isObserving = true;
  await assert.rejects(memory(model).derive({ sessionId: session.sessionId, sourceRevision: first.revision, messages, previous: checkpoint, reflow: false }), /settled synchronous/);
  assert.equal(model.calls.length, before);
});
test('FileStore reopens the real OM package in another process, reuses then updates without raw or tool replay', async (t) => {
  const root = await temporaryDirectory(t, 'sw-om-resume-');
  const { session } = await open(createOfflineOmModel(), new FileStore(root));
  const prepared = await session.prepare(options);
  const modules = ['../dist/index.js', '../dist/file-store.js', '../dist/om.js', '../examples/om-fixture.mjs'].map((entry) => new URL(entry, import.meta.url).href);
  const source = `
    import { SessionWeave } from ${JSON.stringify(modules[0])};
    import { FileStore } from ${JSON.stringify(modules[1])};
    import { createOmWorkingMemory } from ${JSON.stringify(modules[2])};
    import { createOfflineOmModel } from ${JSON.stringify(modules[3])};
    const model = createOfflineOmModel(), session = await SessionWeave.open({ sessionId:'actual-om', store:new FileStore(${JSON.stringify(root)}), workingMemory:createOmWorkingMemory({model,modelId:'fixture/settings@1'}) });
    const options = { strategy:'portable', model:{id:'actor',contextWindow:1000,countTokens:input=>input.messages.some(m=>m.synthetic==='working-memory')?200:950},outputReserveTokens:100,safetyMarginTokens:0,keepRecentGroups:2 };
    const reused = await session.prepare(options), callsAfterReuse = model.calls.length;
    await session.append([{id:'m9',role:'user',text:'Later evidence'},{id:'m10',role:'assistant',text:'Later answer'}]);
    const next = await session.prepare({...options,model:{...options.model,countTokens:input=>input.messages.some(m=>m.text.includes('"endId":"m8"'))?200:800}});
    const checkpoint = await session.read({sessionId:session.sessionId,workingMemoryCheckpointId:next.checkpointId});
    console.log(JSON.stringify({reusedId:reused.checkpointId,callsAfterReuse,calls:model.calls.length,through:checkpoint.activeThroughSequence,messages:(await session.inspect()).messageCount,changed:next.checkpointId!==reused.checkpointId}));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }));
  assert.deepEqual(result, { reusedId: prepared.checkpointId, callsAfterReuse: 0, calls: 1, through: 8, messages: 10, changed: true });
});
