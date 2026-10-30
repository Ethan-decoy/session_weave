import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { json } from '../dist/data.js';
import { createOpenAINativeAdapter, confirmedNativeCapability } from '../dist/native-adapters.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOfflineOmModel } from '../examples/om-fixture.mjs';

const identity = { engine: 'ticket-fixture@1', codec: 'complete-json@1', policy: 'research@1' };
const messages = Array.from({ length: 8 }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? 'assistant' : 'user', text: `Original ${index + 1}` }));
const options = { strategy: 'portable', model: { id: 'current-actor', contextWindow: 4000, countTokens: () => 200 }, outputReserveTokens: 100, safetyMarginTokens: 0, keepRecentGroups: 2 };
const conflict = (error) => error.code === 'REVISION_CONFLICT';
function candidate(request, active = request.messages.length) {
  return { complete: true, sourceRevision: request.sourceRevision, sourceThroughId: request.messages.at(-1).id,
    activeThroughId: request.messages[active - 1]?.id ?? null, identity: structuredClone(identity),
    engineState: { inputIds: request.messages.map((message) => message.id), previous: request.previous?.id ?? null },
    projection: active ? 'Captured historical memory.' : '',
    sources: active ? [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.messages[active - 1].id }] : [] };
}
function engine(hook) {
  const requests = [];
  return { identity: structuredClone(identity), requests, async derive(request, signal) {
    requests.push(structuredClone(request));
    return await hook?.(request, signal) ?? candidate(request);
  } };
}
async function open(memory = engine(), store = new MemoryStore()) {
  const session = await SessionWeave.open({ sessionId: 'tickets', store, workingMemory: memory });
  await session.append(messages);
  return { session, store, memory };
}
async function strictCandidate(session, end = 4) {
  const state = await session.inspect();
  return candidate({ sessionId: session.sessionId, sourceRevision: state.revision, previous: null,
    messages: await session.read({ sessionId: session.sessionId, startId: 'm1', endId: `m${end}` }) });
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fileFixture(t, Store = FileStore) {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, 'sw-ticket-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('sw-ticket-'));
    await rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, createHash('sha256').update('tickets').digest('hex'));
  return { root, folder, store: new Store(root) };
}
function native() {
  const adapter = createOpenAINativeAdapter({ backend: { provider: 'fixture', endpoint: 'https://fixture.invalid/v1', model: 'fixture-model', apiVersion: 'fixture-v1', scope: 'offline' },
    mode: 'server-threshold', thresholdTokens: 500, countTokens: () => 20, generate: async () => { throw Error('No provider execution expected.'); } });
  return { ...options, strategy: 'native', model: { ...options.model, backend: adapter.binding, nativeCompaction: confirmedNativeCapability(adapter, 'Offline protocol fixture') } };
}

test('precomputation keeps its original source through concurrent appends; a new request adopts with current options and three distinct revisions', async () => {
  const entered = deferred(), finish = deferred();
  const fixture = await open(engine(async () => { entered.resolve(); await finish.promise; }));
  const { session, store, memory } = fixture;
  const pending = session.precomputeWorkingMemory({ throughId: 'm4' });
  await entered.promise;
  await session.append([{ id: 'm9', role: 'user', text: 'Current user B' }]);
  await session.append([{ id: 'm10', role: 'assistant', text: 'Newest completed group' }]);
  finish.resolve();
  const ticket = await pending;
  assert.equal(ticket.sourceRevision, 1);
  assert.equal((await session.inspect()).revision, 3);
  assert.equal((await session.inspect()).workingMemoryCheckpoint, null);
  const counted = [];
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket, systemPrompt: 'Instructions for B', tools: [{ name: 'tool_for_B' }], materials: [{ id: 'B', text: 'Material B' }],
    model: { ...options.model, id: 'new-actor-B', countTokens(input) { counted.push(input); return 200; } } });
  assert.equal(memory.requests.length, 1);
  assert.deepEqual(memory.requests[0].messages.map((message) => message.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(context.revision, 4);
  assert.equal(context.usageBasis.revision, 4);
  assert.equal(context.usageBasis.checkpointId, context.checkpointId);
  assert.equal(context.modelId, 'new-actor-B');
  assert.equal(context.systemPrompt, 'Instructions for B');
  assert.deepEqual(context.tools, [{ name: 'tool_for_B' }]);
  assert.ok(context.messages.some((message) => message.text.includes('Material B')));
  assert.deepEqual(context.messages.filter((message) => !message.synthetic).map((message) => message.id), ['m5', 'm6', 'm7', 'm8', 'm9', 'm10']);
  assert.equal(counted.length, 1);
  assert.ok(counted[0].messages[0].id.endsWith(context.checkpointId));
  const saved = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: context.checkpointId });
  assert.equal(saved.version, 2); assert.equal(saved.sourceRevision, 1); assert.equal(saved.publishedFromRevision, 3);
  assert.equal(saved.provenance.sourceMessageCount, 8); assert.equal(saved.publishedMessageCount, 10);
  assert.deepEqual(saved.provenance.appendReceipts, [{ revision: 2, startSequence: 9, endSequence: 9 }, { revision: 3, startSequence: 10, endSequence: 10 }]);
  assert.equal((await store.load('tickets')).version, 3);
});
test('generation does not publish; an explicit ticket is adopted even when the raw request already fits', async () => {
  const { session, store } = await open(), before = await store.load('tickets');
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  assert.deepEqual(await store.load('tickets'), before);
  assert.ok(Object.isFrozen(ticket));
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  assert.equal(context.origin, 'working-memory'); assert.equal(context.revision, 2);
  const corrupt = await store.load('tickets'), checkpoint = corrupt.workingMemoryCheckpoints[0];
  checkpoint.provenance.sourceMessageCount = 6; checkpoint.publishedMessageCount = 6;
  const smallerDigest = createHash('sha256').update(json({ sessionId: 'tickets', messages: corrupt.messages.slice(0, 6) })).digest('hex');
  checkpoint.provenance.sourceRawDigest = smallerDigest; checkpoint.publishedRawDigest = smallerDigest;
  await assert.rejects(SessionWeave.open({ sessionId: 'tickets', store: { supportsWorkingMemoryState: true, supportsWorkingMemoryProvenance: true,
    load: async () => corrupt, commit: store.commit.bind(store) } }), /historical raw transaction boundaries/);
});
test('budget failure and cancellation retain state and allow an explicit retry of the same candidate', async () => {
  const { session, store, memory } = await open(), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  await session.append([{ id: 'new', role: 'user', text: 'Latest' }]);
  const before = await store.load('tickets');
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket, model: { ...options.model, countTokens: () => 5000 } }), (error) => error.code === 'CONTEXT_BUDGET');
  const controller = new AbortController();
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket, signal: controller.signal, model: { ...options.model, countTokens() { controller.abort(); return 1; } } }), (error) => error.name === 'AbortError');
  assert.deepEqual(await store.load('tickets'), before);
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  assert.equal(context.revision, 3); assert.equal(memory.requests.length, 1);
});
test('two concurrent adoptions have one CAS winner, and a committed ticket cannot be published again', async () => {
  const { session, store } = await open(), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  const gate = deferred(); let counted = 0;
  const settings = { ...options, workingMemoryTicket: ticket, model: { ...options.model, async countTokens() { if (++counted === 2) gate.resolve(); await gate.promise; return 100; } } };
  const results = await Promise.allSettled([session.prepare(settings), session.prepare(settings)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(conflict(results.find((item) => item.status === 'rejected').reason));
  assert.equal((await store.load('tickets')).workingMemoryCheckpoints.length, 1);
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), conflict);
});
test('copied, reopened or cross-session tickets and changed engine policies are rejected', async () => {
  const { session, store, memory } = await open(), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  const reopened = await SessionWeave.open({ sessionId: 'tickets', store, workingMemory: memory });
  const other = await SessionWeave.open({ sessionId: 'other', store, workingMemory: memory });
  await other.append([{ id: 'u', role: 'user', text: 'Other' }]);
  for (const [target, value] of [[session, { ...ticket }], [reopened, ticket], [other, ticket]]) await assert.rejects(target.prepare({ ...options, workingMemoryTicket: value }), (error) => error.code === 'WORKING_MEMORY_TICKET_INVALID');
  memory.identity.policy = 'changed';
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), (error) => error.code === 'WORKING_MEMORY_TICKET_INVALID');
});
test('tickets do not override native strategy or relax stale public publication and actor response checks', async () => {
  const { session } = await open(), oldContext = await session.prepare(options);
  const external = await strictCandidate(session), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  await assert.rejects(session.prepare({ ...native(), workingMemoryTicket: ticket }), (error) => error.code === 'WORKING_MEMORY_TICKET_INVALID');
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  await assert.rejects(session.publishWorkingMemory(external), conflict);
  await assert.rejects(session.append([{ id: 'stale-actor', role: 'assistant', text: 'Old response' }], { expectedRevision: oldContext.revision, usage: { basis: oldContext.usageBasis, inputTokens: 200, outputTokens: 1 } }), conflict);
  assert.equal(context.budget.usageAdjustmentTokens, 0);
});
test('memory, Handoff and native base changes invalidate a candidate even with the same raw prefix', async () => {
  for (const kind of ['memory', 'handoff', 'native']) {
    const { session, store } = await open(), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
    if (kind === 'memory') await session.publishWorkingMemory(await strictCandidate(session));
    if (kind === 'handoff') await store.commit('tickets', 1, { checkpoint: { id: 'handoff-base', createdAt: new Date().toISOString(), sourceRevision: 1,
      throughId: 'm2', throughSequence: 2, previousId: null, summarizerId: 'fixture', handoff: { version: 1,
        goals: [{ text: 'Historical Handoff', refs: [{ sessionId: 'tickets', startId: 'm1', endId: 'm2' }] }], constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [] } } });
    if (kind === 'native') {
      const context = await session.prepare(native());
      await session.accept(context, { id: 'native-response', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native public reply', annotations: [] }] }] });
    }
    await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), conflict);
  }
});
test('unproven revision gaps and dropped append receipts fail closed rather than rewriting the source revision', async () => {
  for (const kind of ['empty', 'usage', 'drop']) {
    const backing = new MemoryStore(); let drop = false;
    const store = { supportsWorkingMemoryState: true, supportsWorkingMemoryProvenance: true, commit: backing.commit.bind(backing), async load(id) {
      const state = await backing.load(id); return state && drop ? { ...state, appendLog: [] } : state;
    } };
    const { session } = await open(engine(), store), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
    if (kind === 'empty') await backing.commit('tickets', 1, {});
    if (kind === 'usage') await backing.commit('tickets', 1, { usage: { basis: { sessionId: 'tickets', revision: 1, modelId: 'old', fixedHash: 'fixture', checkpointId: null, messageIds: [], estimatedInputTokens: 0 }, inputTokens: 1, outputTokens: 0 } });
    await session.append([{ id: 'after', role: 'user', text: 'New tail' }]);
    if (kind === 'drop') drop = true;
    await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), conflict);
  }
});
test('both the processed prefix and the captured protected source tail are immutable', async () => {
  for (const index of [0, 7]) {
    const backing = new MemoryStore(); let change = false;
    const store = { supportsWorkingMemoryState: true, supportsWorkingMemoryProvenance: true, commit: backing.commit.bind(backing), async load(id) {
      const state = await backing.load(id); if (state && change) state.messages[index].text = 'Changed stored evidence'; return state;
    } };
    const { session } = await open(engine(), store), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
    change = true;
    await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), conflict);
  }
});
test('pending tail tools block adoption until real results arrive; buffered source is still retained raw', async () => {
  const { session } = await open(engine((request) => candidate(request, 2)));
  await session.append([{ id: 'call', role: 'assistant', text: '', toolCalls: [{ id: 'operation', name: 'host_tool', arguments: {} }] }]);
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket }), (error) => error.code === 'PENDING_TOOLS');
  await session.append([{ id: 'result', role: 'tool', callId: 'operation', name: 'host_tool', text: 'Real result', isError: false }]);
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  assert.deepEqual(context.messages.filter((message) => !message.synthetic).map((message) => message.id), ['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'call', 'result']);
});
test('an append during final adoption counting still conflicts; a new prepare may explicitly retry', async () => {
  const { session, memory } = await open(), ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket, model: { ...options.model, async countTokens() {
    await session.append([{ id: 'arrived', role: 'user', text: 'Concurrent new user' }]); return 100;
  } } }), conflict);
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket, systemPrompt: 'New request for arrived user' });
  assert.equal(context.revision, 3); assert.equal(memory.requests.length, 1);
});
test('older adopted packages retain their historical bases after further v2 and strict v1 publications', async () => {
  const { session, store, memory } = await open();
  const first = await session.publishWorkingMemory(await strictCandidate(session));
  const one = await session.precomputeWorkingMemory({ throughId: 'm6' });
  assert.equal(memory.requests.at(-1).previous.id, first.checkpointId);
  await session.append([{ id: 'm9', role: 'user', text: 'Next' }]);
  const adopted = await session.prepare({ ...options, workingMemoryTicket: one });
  const old = await session.read({ sessionId: 'tickets', workingMemoryCheckpointId: adopted.checkpointId });
  const two = await session.precomputeWorkingMemory({ throughId: 'm8' });
  await session.append([{ id: 'm10', role: 'assistant', text: 'Reply' }]);
  await session.prepare({ ...options, workingMemoryTicket: two });
  await session.publishWorkingMemory(await strictCandidate(session, 8));
  assert.equal((await store.load('tickets')).version, 3);
  const reopened = await SessionWeave.open({ sessionId: 'tickets', store });
  assert.deepEqual(await reopened.read({ sessionId: 'tickets', workingMemoryCheckpointId: old.id }), old);
  await assert.rejects(SessionWeave.open({ sessionId: 'tickets', store: { supportsWorkingMemoryState: true, load: store.load.bind(store), commit: store.commit.bind(store) } }), (error) => error.code === 'WORKING_MEMORY_PROVENANCE_UNSUPPORTED');
});
test('storage must explicitly preserve provenance and invalid fixed prefixes do not reach the engine', async () => {
  const backing = new MemoryStore(), memory = engine();
  const store = { supportsWorkingMemoryState: true, load: backing.load.bind(backing), commit: backing.commit.bind(backing) };
  const { session } = await open(memory, store);
  await assert.rejects(session.precomputeWorkingMemory({ throughId: 'm4' }), (error) => error.code === 'WORKING_MEMORY_PROVENANCE_UNSUPPORTED');
  assert.equal(memory.requests.length, 0);
  const fixture = await open();
  await assert.rejects(fixture.session.precomputeWorkingMemory({ throughId: 'missing' }), /closed raw prefix/);
  await fixture.session.append([{ id: 'pending', role: 'assistant', text: '', toolCalls: [{ id: 'pending-op', name: 'host', arguments: {} }] }]);
  await assert.rejects(fixture.session.precomputeWorkingMemory({ throughId: 'pending' }), /closed raw prefix/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.session.precomputeWorkingMemory({ throughId: 'm4', signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(fixture.memory.requests.length, 0);
});
test('cancelled, failed or invalid candidate generation never publishes a package or a usable ticket', async () => {
  for (const mode of ['cancel', 'failure', 'coverage']) {
    const controller = new AbortController();
    const { session, store } = await open(engine((request) => {
      if (mode === 'cancel') controller.abort();
      if (mode === 'failure') throw Error('Offline generation failed');
      return { ...candidate(request), ...(mode === 'coverage' ? { sourceThroughId: 'm3' } : {}) };
    }));
    const before = await store.load('tickets');
    await assert.rejects(session.precomputeWorkingMemory({ throughId: 'm4', signal: controller.signal }));
    assert.deepEqual(await store.load('tickets'), before);
  }
});
test('FileStore cancellation at the v4 publication point leaves only an inactive package and permits explicit retry', async (t) => {
  const controller = new AbortController(); let cancel = false;
  class CancellingStore extends FileStore {
    async write(file, contents) { await super.write(file, contents); if (cancel && path.basename(file).startsWith('manifest-')) controller.abort(); }
  }
  const fixture = await fileFixture(t, CancellingStore), { session } = await open(engine(), fixture.store);
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  await session.append([{ id: 'new', role: 'user', text: 'Latest input' }]);
  const before = await new FileStore(fixture.root).load('tickets');
  cancel = true;
  await assert.rejects(session.prepare({ ...options, workingMemoryTicket: ticket, signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.deepEqual(await new FileStore(fixture.root).load('tickets'), before);
  cancel = false;
  await session.prepare({ ...options, workingMemoryTicket: ticket });
  assert.equal((await new FileStore(fixture.root).load('tickets')).version, 3);
});
test('FileStore upgrades legacy v3 packages to v4, validates provenance after restart, and keeps raw immutable', async (t) => {
  const fixture = await fileFixture(t), { session } = await open(engine(), fixture.store);
  await session.publishWorkingMemory(await strictCandidate(session));
  const manifestFile = path.join(fixture.folder, 'manifest.json');
  const legacy = JSON.parse(await readFile(manifestFile, 'utf8')); delete legacy.appendLog;
  await writeFile(manifestFile, JSON.stringify(legacy));
  const rawBefore = await Promise.all(messages.map((message) => readFile(path.join(fixture.folder, 'raw', `${message.id}.json`), 'utf8')));
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm6' });
  await session.append([{ id: 'new', role: 'user', text: 'New tail' }]);
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  assert.equal(JSON.parse(await readFile(manifestFile, 'utf8')).version, 4);
  assert.deepEqual(await Promise.all(messages.map((message) => readFile(path.join(fixture.folder, 'raw', `${message.id}.json`), 'utf8'))), rawBefore);
  const source = `import {SessionWeave} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    import {FileStore} from ${JSON.stringify(new URL('../dist/file-store.js', import.meta.url).href)};
    const session=await SessionWeave.open({sessionId:'tickets',store:new FileStore(${JSON.stringify(fixture.root)})});
    const checkpoint=await session.read({sessionId:'tickets',workingMemoryCheckpointId:${JSON.stringify(context.checkpointId)}});
    console.log(JSON.stringify({status:await session.inspect(),checkpoint}));`;
  const recovered = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }));
  assert.equal(recovered.checkpoint.sourceRevision, 2); assert.equal(recovered.checkpoint.publishedFromRevision, 3); assert.equal(recovered.status.revision, 4);
  const file = path.join(fixture.folder, 'working-memory', `${context.checkpointId}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  for (const edit of [
    (value) => { value.sourceRevision = value.publishedFromRevision; },
    (value) => { value.provenance.base.nativeId = 'invented'; },
    (value) => { value.provenance.previousUsedId = 'invented'; },
    (value) => { value.provenance.appendReceipts = []; },
    (value) => { value.publishedRawDigest = 'changed'; },
  ]) {
    const corrupt = structuredClone(saved); edit(corrupt); await writeFile(file, JSON.stringify(corrupt));
    await assert.rejects(new FileStore(fixture.root).load('tickets'));
  }
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await new FileStore(fixture.root).load('tickets')).version, 3);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')), missing = structuredClone(manifest);
  delete missing.appendLog;
  await writeFile(manifestFile, JSON.stringify(missing));
  await assert.rejects(new FileStore(fixture.root).load('tickets'), /explicit append receipts/);
  await writeFile(manifestFile, JSON.stringify(manifest));
});
test('real OM can generate a fixed-prefix ticket and resume its complete state after adoption', async () => {
  let session;
  const model = createOfflineOmModel({ async onCall({ index }) { if (index === 1) await session.append([{ id: 'arrived', role: 'user', text: 'Current request' }]); } });
  const store = new MemoryStore(), workingMemory = createOmWorkingMemory({ model, modelId: 'ticket-sdk-fixture@1' });
  session = await SessionWeave.open({ sessionId: 'tickets', store, workingMemory });
  await session.append(messages);
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm4' });
  const context = await session.prepare({ ...options, workingMemoryTicket: ticket });
  const reopened = await SessionWeave.open({ sessionId: 'tickets', store, workingMemory });
  const reused = await reopened.prepare(options);
  assert.equal(reused.checkpointId, context.checkpointId); assert.equal(model.calls.length, 1);
  const next = await reopened.precomputeWorkingMemory({ throughId: 'm6' });
  await reopened.prepare({ ...options, workingMemoryTicket: next });
  assert.equal(model.calls.length, 2);
});
