import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { createOpenAINativeAdapter, confirmedNativeCapability } from '../dist/native-adapters.js';
import { temporaryDirectory } from './helpers/temporary-directory.mjs';

const messages = [
  { id: 'u1', role: 'user', text: 'Original question' },
  { id: 'a1', role: 'assistant', text: 'Recorded answer' },
  { id: 'u2', role: 'user', text: 'Next question' },
  { id: 'a2', role: 'assistant', text: 'Next answer' },
];
async function open(store = new MemoryStore(), extra = {}) {
  const session = await SessionWeave.open({ sessionId: 'memory-session', store, ...extra });
  await session.append(messages);
  return session;
}
async function candidate(session, extra = {}) {
  return { complete: true, sourceRevision: (await session.inspect()).revision,
    sourceThroughId: 'a2', activeThroughId: 'a1',
    identity: { engine: 'deterministic-state@1', codec: 'fixture-json@1', policy: 'retain-facts@1' },
    engineState: { generation: 'fixture-generation', rows: [{ id: 'row-1', observations: 'Original question answered' }],
      bufferedIds: ['u2', 'a2'], cursor: 2, thread: { id: 'fixture-thread', metadata: { answerKnown: true } } },
    projection: 'The first question has a recorded answer.',
    sources: [{ sessionId: session.sessionId, startId: 'u1', endId: 'a1' }], ...extra };
}
async function fileFixture(t, Store = FileStore) {
  const root = await temporaryDirectory(t, 'sw-working-memory-');
  const folder = path.join(root, createHash('sha256').update('memory-session').digest('hex'));
  return { root, folder, store: new Store(root) };
}

test('one publication preserves complete state, projection, references and raw records together', async () => {
  const store = new MemoryStore(), events = [], session = await open(store, { onEvent: (event) => events.push(event) });
  const before = await store.load(session.sessionId), input = await candidate(session);
  const pending = session.publishWorkingMemory(input);
  input.engineState.rows[0].observations = 'Changed after publication was called';
  input.projection = 'Changed projection';
  const receipt = await pending;
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: receipt.checkpointId });
  assert.equal(receipt.revision, before.revision + 1);
  assert.equal(checkpoint.engineState.rows[0].observations, 'Original question answered');
  assert.equal(checkpoint.projection, 'The first question has a recorded answer.');
  assert.deepEqual(checkpoint.engineState.bufferedIds, ['u2', 'a2']);
  assert.equal(checkpoint.sourceThroughSequence, 4);
  assert.equal(checkpoint.activeThroughSequence, 2);
  const after = await store.load(session.sessionId);
  assert.equal(after.version, 2);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.checkpoints, []);
  assert.deepEqual(after.nativeCheckpoints, []);
  assert.equal((await session.inspect()).workingMemoryCheckpoint.id, receipt.checkpointId);
  assert.equal(events.filter((event) => event.type === 'working-memory-committed').length, 1);
  checkpoint.engineState.cursor = 999;
  assert.equal((await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: receipt.checkpointId })).engineState.cursor, 2);
});

test('later full packages retain the previous checkpoint instead of editing it', async () => {
  const session = await open();
  const first = await session.publishWorkingMemory(await candidate(session));
  const original = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: first.checkpointId });
  const nextInput = await candidate(session, { activeThroughId: 'a2', projection: 'Both exchanges recorded.',
    sources: [{ sessionId: session.sessionId, startId: 'u1', endId: 'a2' }] });
  nextInput.engineState.bufferedIds = [];
  nextInput.engineState.cursor = 4;
  const second = await session.publishWorkingMemory(nextInput);
  const latest = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: second.checkpointId });
  assert.equal(latest.previousId, first.checkpointId);
  assert.equal(latest.activeThroughSequence, 4);
  assert.deepEqual(await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: first.checkpointId }), original);
});

test('buffered input is not confused with active historical coverage', async () => {
  const session = await open();
  const receipt = await session.publishWorkingMemory(await candidate(session, { activeThroughId: null, projection: '', sources: [] }));
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: receipt.checkpointId });
  assert.equal(checkpoint.activeThroughSequence, 0);
  assert.equal(checkpoint.sourceThroughSequence, 4);
  assert.equal((await session.inspect()).messageCount, 4);
  const context = await session.prepare({ strategy: 'portable', model: { id: 'fixture', contextWindow: 1000, countTokens: () => 100 }, outputReserveTokens: 100 });
  assert.equal(context.checkpointId, receipt.checkpointId);
  assert.deepEqual(context.messages.filter((message) => !message.synthetic).map((message) => message.id), messages.map((message) => message.id));
});

test('incomplete, non-JSON, untraceable or invalid-coverage packages never become visible', async () => {
  const session = await open(), before = await session.inspect();
  const invalid = [
    { complete: false }, { sourceThroughId: 'missing' }, { activeThroughId: 'missing' },
    { sourceThroughId: 'u1', activeThroughId: 'a1' }, { identity: { engine: 'fixture', codec: '', policy: 'policy' } },
    { engineState: 'observations alone are not a state object' }, { engineState: { date: new Date() } },
    { projection: '' }, { sources: [] },
    { sources: [{ sessionId: 'another-session', startId: 'u1', endId: 'a1' }] },
    { sources: [{ sessionId: session.sessionId, startId: 'a1', endId: 'a1' }] },
    { sources: [{ sessionId: session.sessionId, startId: 'u1', endId: 'a2' }] },
  ];
  for (const change of invalid) {
    await assert.rejects(session.publishWorkingMemory(await candidate(session, change)));
    assert.deepEqual(await session.inspect(), before);
  }
});

test('the input and active boundary cannot split a parallel tool protocol group', async () => {
  const session = await SessionWeave.open({ sessionId: 'memory-session', store: new MemoryStore() });
  await session.append([
    messages[0], { id: 'a1', role: 'assistant', text: '', toolCalls: [{ id: 'call-a', name: 'a', arguments: {} }, { id: 'call-b', name: 'b', arguments: {} }] },
    { id: 'r1', role: 'tool', callId: 'call-a', name: 'a', text: 'A result', isError: false },
    { id: 'r2', role: 'tool', callId: 'call-b', name: 'b', text: 'B result', isError: false },
  ]);
  for (const partial of ['a1', 'r1']) {
    await assert.rejects(session.publishWorkingMemory(await candidate(session, { sourceThroughId: partial, activeThroughId: 'u1', sources: [{ sessionId: session.sessionId, startId: 'u1', endId: 'u1' }] })));
    await assert.rejects(session.publishWorkingMemory(await candidate(session, { sourceThroughId: 'r2', activeThroughId: partial })));
  }
  const receipt = await session.publishWorkingMemory(await candidate(session, { sourceThroughId: 'r2', activeThroughId: 'r2', sources: [{ sessionId: session.sessionId, startId: 'u1', endId: 'r2' }] }));
  assert.equal(receipt.activeThroughSequence, 4);
});

test('a stale candidate cannot replace new input, and concurrent candidates have one winner', async () => {
  let session;
  class ArrivalStore extends MemoryStore {
    insert = false;
    async commit(id, revision, mutation, signal) {
      if (mutation.workingMemoryCheckpoint && this.insert) {
        this.insert = false;
        await session.append([{ id: 'arrived', role: 'user', text: 'New input' }]);
      }
      return super.commit(id, revision, mutation, signal);
    }
  }
  const store = new ArrivalStore();
  session = await open(store);
  const stale = await candidate(session);
  store.insert = true;
  await assert.rejects(session.publishWorkingMemory(stale), (error) => error.code === 'REVISION_CONFLICT');
  const fresh = await candidate(session);
  const results = await Promise.allSettled([session.publishWorkingMemory(fresh), session.publishWorkingMemory(fresh)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await session.inspect()).messageCount, 5);
  assert.equal((await session.read({ sessionId: session.sessionId, startId: 'arrived', endId: 'arrived' }))[0].text, 'New input');
});

test('cancellation at store publication retains the previous complete package', async () => {
  const controller = new AbortController();
  class CancellingStore extends MemoryStore {
    cancel = false;
    async commit(id, revision, mutation, signal) {
      if (mutation.workingMemoryCheckpoint && this.cancel) controller.abort();
      return super.commit(id, revision, mutation, signal);
    }
  }
  const store = new CancellingStore(), session = await open(store);
  await session.publishWorkingMemory(await candidate(session));
  const before = await store.load(session.sessionId);
  store.cancel = true;
  await assert.rejects(session.publishWorkingMemory(await candidate(session), { signal: controller.signal }));
  assert.deepEqual(await store.load(session.sessionId), before);
});

test('custom stores must opt in, and a format-2 state cannot silently lose its memory', async () => {
  const backing = new MemoryStore();
  const legacy = { load: backing.load.bind(backing), commit: backing.commit.bind(backing) };
  const session = await open(legacy);
  await assert.rejects(session.publishWorkingMemory(await candidate(session)), (error) => error.code === 'WORKING_MEMORY_STORAGE_UNSUPPORTED');
  const supported = await SessionWeave.open({ sessionId: session.sessionId, store: backing });
  await supported.publishWorkingMemory(await candidate(supported));
  await assert.rejects(SessionWeave.open({ sessionId: session.sessionId, store: legacy }), (error) => error.code === 'WORKING_MEMORY_STORAGE_UNSUPPORTED');
  const broken = { supportsWorkingMemoryState: true, load: async () => ({ ...await backing.load(session.sessionId), workingMemoryCheckpoints: [] }), commit: backing.commit.bind(backing) };
  await assert.rejects(SessionWeave.open({ sessionId: session.sessionId, store: broken }), /cannot be silently omitted/u);
});

test('working-memory publication cannot be mixed with a raw append in one mutation', async () => {
  const store = new MemoryStore(), session = await open(store);
  await session.publishWorkingMemory(await candidate(session));
  const before = await store.load(session.sessionId), previous = before.workingMemoryCheckpoints.at(-1);
  const next = { ...previous, id: 'next-memory', previousId: previous.id, sourceRevision: before.revision };
  await assert.rejects(store.commit(session.sessionId, before.revision, { workingMemoryCheckpoint: next, messages: [] }), /package alone/u);
  assert.deepEqual(await store.load(session.sessionId), before);
});

test('FileStore upgrades v1 to v3 and restores the complete package in a separate process', async (t) => {
  const { root, folder, store } = await fileFixture(t), session = await open(store);
  const rawFile = path.join(folder, 'raw/u1.json'), original = await readFile(rawFile), originalStat = await stat(rawFile);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).version, 1);
  const receipt = await session.publishWorkingMemory(await candidate(session));
  const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: receipt.checkpointId });
  const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.workingMemoryCheckpoints, [receipt.checkpointId]);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'working-memory', `${receipt.checkpointId}.json`), 'utf8')), checkpoint);
  assert.deepEqual(await readFile(rawFile), original);
  assert.equal((await stat(rawFile)).mtimeMs, originalStat.mtimeMs);
  const code = `import {SessionWeave} from ${JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)};
import {FileStore} from ${JSON.stringify(pathToFileURL(path.resolve('dist/file-store.js')).href)};
const s=await SessionWeave.open({sessionId:'memory-session',store:new FileStore(${JSON.stringify(root)}),summarizer:{summarize(){throw Error('must not generate on restore')}}});
console.log(JSON.stringify({status:await s.inspect(),checkpoint:await s.read({sessionId:s.sessionId,workingMemoryCheckpointId:${JSON.stringify(receipt.checkpointId)}})}));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.deepEqual(restored.checkpoint, checkpoint);
  assert.equal(restored.status.messageCount, 4);
  assert.deepEqual(restored.status.pendingCallIds, []);
});

test('a failure after writing an immutable package leaves only an inactive orphan', async (t) => {
  class InterruptedStore extends FileStore {
    interrupt = true;
    async write(file, contents) {
      await super.write(file, contents);
      if (this.interrupt && path.basename(path.dirname(file)) === 'working-memory') { this.interrupt = false; throw Error('Interrupted before manifest publication'); }
    }
  }
  const { store, folder } = await fileFixture(t, InterruptedStore), session = await open(store);
  const before = await readFile(path.join(folder, 'manifest.json'));
  const input = await candidate(session);
  await assert.rejects(session.publishWorkingMemory(input), /Interrupted before/u);
  assert.deepEqual(await readFile(path.join(folder, 'manifest.json')), before);
  assert.equal((await session.inspect()).workingMemoryCheckpoint, null);
  assert.equal((await readdir(path.join(folder, 'working-memory'))).length, 1);
  await session.publishWorkingMemory(input);
  assert.equal((await readdir(path.join(folder, 'working-memory'))).length, 2);
});

test('cancellation after file persistence does not publish a new manifest', async (t) => {
  const controller = new AbortController();
  class CancelAfterWrite extends FileStore {
    cancel = false;
    async write(file, contents) {
      await super.write(file, contents);
      if (this.cancel && path.basename(path.dirname(file)) === 'working-memory') controller.abort();
    }
  }
  const { store, folder } = await fileFixture(t, CancelAfterWrite), session = await open(store);
  await session.publishWorkingMemory(await candidate(session));
  const before = await readFile(path.join(folder, 'manifest.json'));
  store.cancel = true;
  await assert.rejects(session.publishWorkingMemory(await candidate(session), { signal: controller.signal }));
  assert.deepEqual(await readFile(path.join(folder, 'manifest.json')), before);
  assert.equal((await session.inspect()).revision, 2);
});

test('missing or incomplete committed packages fail instead of appearing as empty memory', async (t) => {
  const { store, folder } = await fileFixture(t), session = await open(store);
  const receipt = await session.publishWorkingMemory(await candidate(session));
  const file = path.join(folder, 'working-memory', `${receipt.checkpointId}.json`);
  const original = await readFile(file, 'utf8'), corrupted = JSON.parse(original);
  delete corrupted.engineState;
  await writeFile(file, JSON.stringify(corrupted));
  await assert.rejects(session.inspect(), /encoded JSON object/u);
  await writeFile(file, original);
  await rm(file);
  await assert.rejects(session.inspect(), /ENOENT/u);
});

test('native v2 records survive a working-memory upgrade and remain usable', async (t) => {
  const { store, folder } = await fileFixture(t), session = await open(store);
  const adapter = createOpenAINativeAdapter({ backend: { provider: 'fixture', endpoint: 'https://offline.invalid/v1', model: 'fixture', apiVersion: 'v1', scope: 'fixture' },
    mode: 'server-threshold', thresholdTokens: 500, countTokens: () => 1, generate: async () => { throw Error('no model calls'); } });
  const options = { model: { id: 'fixture', contextWindow: 2000, countTokens: () => 1, backend: adapter.binding, nativeCompaction: confirmedNativeCapability(adapter, 'Offline fixture only') }, outputReserveTokens: 100 };
  const context = await session.prepare(options);
  const nativeReceipt = await session.accept(context, { id: 'native-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recorded native reply' }] }] });
  const native = await session.read({ sessionId: session.sessionId, nativeCheckpointId: nativeReceipt.nativeCheckpointId });
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).version, 2);
  await session.publishWorkingMemory(await candidate(session));
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).version, 3);
  assert.deepEqual(await session.read({ sessionId: session.sessionId, nativeCheckpointId: nativeReceipt.nativeCheckpointId }), native);
  assert.equal((await session.prepare(options)).strategy, 'native');
});
