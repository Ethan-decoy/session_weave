import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContextBudgetError, MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { createAnthropicNativeAdapter, createOpenAINativeAdapter, confirmedNativeCapability } from '../dist/native-adapters.js';
import { toPiContext } from '../dist/pi.js';
import { temporaryDirectory } from './helpers/temporary-directory.mjs';

const count = (input) => Math.ceil(JSON.stringify(input).length / 4);
const options = (extra = {}) => ({ strategy: 'portable', model: { id: 'fixture/actor/counter@1', contextWindow: 100_000, countTokens: count }, outputReserveTokens: 100, safetyMarginTokens: 0, ...extra });
const set = (version, text = `Evidence ${version}`, id = 'reference') => ({ id, version, action: 'set', text });
const withdraw = (version, id = 'reference') => ({ id, version, action: 'withdraw' });
const conflict = (error) => error.code === 'REVISION_CONFLICT';
async function open(extra = {}) {
  const store = extra.store ?? new MemoryStore(), session = await SessionWeave.open({ sessionId: 'materials', store, ...extra });
  await session.append([{ id: 'u', role: 'user', text: 'Keep this actual user input.' }]);
  return { session, store };
}
const materialMessages = (input) => input.messages.filter((m) => m.id.startsWith('material-revision:'));
const readMaterial = (session, version, id = 'reference') => session.read({ sessionId: session.sessionId, materialId: id, version });
const identity = { engine: 'fixture@1', codec: 'json@1', policy: 'history@1' };
const memory = { identity, async derive(request) {
  return { complete: true, sourceRevision: request.sourceRevision, sourceThroughId: request.messages.at(-1).id,
    activeThroughId: request.messages.at(-1).id, identity, engineState: { rawIds: request.messages.map((m) => m.id) },
    projection: 'Historical evidence says the former value was 12.', sources: [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.messages.at(-1).id }] };
} };

test('unchanged revisions are deterministic; new material events extend the actual prior portable input prefix', async () => {
  const { session, store } = await open();
  await session.updateMaterials([set('v1', 'The value is 12.')]);
  const first = await session.prepare(options()), revision = (await session.inspect()).revision;
  assert.deepEqual(await session.prepare(options()), first);
  assert.equal((await session.inspect()).revision, revision);
  await session.append([{ id: 'a', role: 'assistant', text: 'Decision based on v1.' }], { expectedRevision: first.revision });
  await session.updateMaterials([set('v2', 'Correction: the current value is 15.')]);
  const second = await session.prepare(options());
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  const piModel = { id: 'actor', provider: 'fixture', api: 'fixture', contextWindow: 100_000, maxTokens: 100 };
  assert.deepEqual(toPiContext(second, piModel, []).messages.slice(0, first.messages.length), toPiContext(first, piModel, []).messages);
  assert.equal(second.messages.at(-1).id, 'material-revision:2');
  assert.match(second.messages.at(-1).text, /completely replace or withdraw/u);
  assert.match(second.messages.at(-1).text, /working memory are historical, not current facts/u);
  assert.equal((await readMaterial(session, 'v2')).previousVersion, 'v1');
  assert.equal((await readMaterial(session, 'v1')).text, 'The value is 12.');
  assert.equal((await store.load(session.sessionId)).messages.length, 2);
  assert.equal(second.budget.estimatedInputTokens, count({ systemPrompt: second.systemPrompt, tools: second.tools, messages: second.messages }));
});

test('whole material batches are idempotent, old retries do not reactivate an old version, and identities cannot hide content changes', async () => {
  const { session } = await open(), batch = [set('v1'), set('other-v1', 'Other source', 'other')];
  const first = await session.updateMaterials(batch);
  assert.deepEqual(await session.updateMaterials(batch, { expectedRevision: 0 }), first);
  await assert.rejects(session.updateMaterials([set('v1', 'Different original')]), /complete material batch/u);
  await assert.rejects(session.updateMaterials([set('v1', 'Different original'), batch[1]]), /different content/u);
  await assert.rejects(session.updateMaterials([set('v1'), set('new')]), /partial replay/u);
  await assert.rejects(session.updateMaterials([set('same'), set('same')]), /Duplicate material/u);
  await session.updateMaterials([withdraw('v2')]);
  const current = await session.inspect();
  assert.equal((await session.updateMaterials(batch)).revision, current.revision);
  assert.equal((await session.inspect()).materials.find((m) => m.id === 'reference').action, 'withdraw');
  const withdrawn = await session.prepare(options());
  assert.match(withdrawn.messages.at(-1).text, /WITHDRAWN/u);
  assert.equal((await readMaterial(session, 'v2')).previousVersion, 'v1');
  await session.updateMaterials([set('v3')]);
  assert.equal((await readMaterial(session, 'v3')).previousVersion, 'v2');
  await assert.rejects(session.updateMaterials([withdraw('unknown', 'unknown')]), /known material/u);
  await assert.rejects(session.updateMaterials([{ ...set('bad'), afterSequence: 0 }]), /Unknown material/u);
});

test('initial material revisions before the first user retain explicit event order without timestamps', async () => {
  const store = new MemoryStore(), session = await SessionWeave.open({ sessionId: 'initial', store });
  await session.updateMaterials([set('v1'), set('v2')]);
  await session.append([{ id: 'first', role: 'user', text: 'Question' }]);
  const prepared = await session.prepare(options());
  assert.deepEqual(prepared.messages.map((m) => m.id), ['material-revision:1', 'material-revision:2', 'first']);
  assert.equal(prepared.materialProjection.mode, 'timeline');
  assert.ok(materialMessages(prepared).every((m) => m.createdAt === '1970-01-01T00:00:00.000Z'));
});

test('material events cannot split parallel tool protocol groups or replace the latest real user', async () => {
  const { session } = await open();
  await session.append([{ id: 'calls', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }, { id: 'c2', name: 'read', arguments: {} }] }]);
  await assert.rejects(session.updateMaterials([set('v1')]), /tool results/u);
  await session.append([{ id: 'r1', role: 'tool', callId: 'c1', name: 'read', text: 'One', isError: false }]);
  await assert.rejects(session.updateMaterials([set('v1')]), /tool results/u);
  await session.append([{ id: 'r2', role: 'tool', callId: 'c2', name: 'read', text: 'Two', isError: true }]);
  await session.updateMaterials([set('v1')]);
  const prepared = await session.prepare(options());
  assert.deepEqual(prepared.messages.map((m) => m.id), ['u', 'calls', 'r1', 'r2', 'material-revision:1']);
  assert.equal((await readMaterial(session, 'v1')).afterSequence, 4);
});

test('material storage is opt-in, versions are session isolated, and snapshots cannot override a versioned ID', async () => {
  const backing = new MemoryStore(), unsupported = { load: backing.load.bind(backing), commit: backing.commit.bind(backing) };
  const { session } = await open({ store: unsupported });
  await assert.rejects(session.updateMaterials([set('v1')]), (e) => e.code === 'MATERIAL_STORAGE_UNSUPPORTED');
  const owner = await SessionWeave.open({ sessionId: session.sessionId, store: backing });
  await owner.updateMaterials([set('v1')]);
  await assert.rejects(SessionWeave.open({ sessionId: session.sessionId, store: unsupported }), (e) => e.code === 'MATERIAL_STORAGE_UNSUPPORTED');
  await assert.rejects(owner.read({ sessionId: 'other', materialId: 'reference', version: 'v1' }), /another session/u);
  await assert.rejects(readMaterial(owner, 'missing'), /does not exist/u);
  await assert.rejects(owner.prepare(options({ materials: [{ id: 'reference', text: 'Hide correction' }] })), /mix a versioned material/u);
  await assert.rejects(owner.prepare({ runtime: { id: 'runtime', sessionId: 'external', capabilities: { persistentSessions: true, compaction: true }, evidence: 'Configured' } }), (e) => e.code === 'UNSUPPORTED_STRATEGY');
  const copy = await readMaterial(owner, 'v1'); copy.text = 'outside mutation';
  assert.equal((await readMaterial(owner, 'v1')).text, 'Evidence v1');
});

test('material commits invalidate stale actor plans, counting and precomputed memory adoption', async () => {
  const { session, store } = await open({ workingMemory: memory });
  await session.append(Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', text: `Raw ${i}` })));
  const prepared = await session.prepare(options());
  const ticket = await session.precomputeWorkingMemory({ throughId: 'm3' });
  await session.updateMaterials([set('v1')]);
  await assert.rejects(session.append([{ id: 'stale', role: 'assistant', text: 'Old response' }], { expectedRevision: prepared.revision }), conflict);
  await assert.rejects(session.prepare(options({ workingMemoryTicket: ticket })), conflict);
  const before = await store.load(session.sessionId);
  let once = false;
  await assert.rejects(session.prepare(options({ model: { ...options().model, async countTokens() {
    if (!once) { once = true; await session.updateMaterials([set('v2')]); } return 10;
  } } })), conflict);
  assert.deepEqual((await store.load(session.sessionId)).messages, before.messages);
  assert.equal((await session.inspect()).materials[0].version, 'v2');
});

test('cancellation, a failing store and competing material writers retain atomic revisions', async () => {
  const { session, store } = await open(), before = await store.load(session.sessionId), controller = new AbortController();
  controller.abort();
  await assert.rejects(session.updateMaterials([set('v1')], { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await store.load(session.sessionId), before);
  await assert.rejects(session.updateMaterials([set('v1')], { expectedRevision: 0 }), conflict);
  const other = await SessionWeave.open({ sessionId: session.sessionId, store });
  const outcomes = await Promise.allSettled([session.updateMaterials([set('v1')]), other.updateMaterials([set('v2')])]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal((await store.load(session.sessionId)).materialRevisions.length, 1);
  const failing = { supportsMaterialRevisions: true, load: store.load.bind(store), async commit() { throw Error('Disk failure'); } };
  const broken = await SessionWeave.open({ sessionId: session.sessionId, store: failing }), saved = await store.load(session.sessionId);
  await assert.rejects(broken.updateMaterials([set('v3')]), /Disk failure/u);
  assert.deepEqual(await store.load(session.sessionId), saved);
  const input = set('v4'), captured = { expectedRevision: saved.revision };
  const pending = session.updateMaterials([input], captured);
  input.text = 'Outside mutation'; captured.expectedRevision = -1;
  await pending;
  assert.equal((await readMaterial(session, 'v4')).text, 'Evidence v4');
  const original = new AbortController(), changed = { signal: original.signal };
  const cancelled = session.updateMaterials([set('v5')], changed);
  original.abort(); changed.signal = new AbortController().signal;
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await session.inspect()).materials[0].version, 'v4');
});

test('obsolete material bodies can be folded under budget pressure without calling a model or changing canonical sources', async () => {
  const { session, store } = await open();
  await session.updateMaterials([set('v1', 'OLD_BODY'.repeat(2000))]);
  await session.append([{ id: 'a', role: 'assistant', text: 'The original decision used v1.' }]);
  await session.updateMaterials([set('v2', 'Current value: 15.')]);
  const before = await store.load(session.sessionId), full = await session.prepare(options());
  const compact = await session.prepare(options({ model: { ...options().model, contextWindow: 1000 }, compactAt: 1 }));
  assert.equal(full.materialProjection.mode, 'timeline');
  assert.equal(compact.materialProjection.mode, 'current');
  assert.equal(compact.materialProjection.retainedRevisions, 1);
  assert.ok(compact.budget.remainingTokens >= 0);
  assert.equal(compact.budget.inputTokens, count({ systemPrompt: compact.systemPrompt, tools: compact.tools, messages: compact.messages }));
  assert.notEqual(compact.usageBasis.fixedHash, full.usageBasis.fixedHash);
  assert.ok(compact.messages.some((m) => m.id === 'u'));
  assert.doesNotMatch(JSON.stringify(compact.messages), /OLD_BODY/u);
  assert.equal((await readMaterial(session, 'v1')).text, 'OLD_BODY'.repeat(2000));
  assert.deepEqual(await store.load(session.sessionId), before);
  await session.updateMaterials([withdraw('v3')]);
  const removed = await session.prepare(options({ model: { ...options().model, contextWindow: 1000 }, compactAt: 1 }));
  assert.match(removed.messages.at(-1).text, /WITHDRAWN/u);
  assert.doesNotMatch(JSON.stringify(removed.messages), /Current value: 15/u);
  await session.updateMaterials([set('v4', 'CURRENT_REQUIRED_BODY'.repeat(2000))]);
  await assert.rejects(session.prepare(options({ model: { ...options().model, contextWindow: 1000 } })), ContextBudgetError);
  assert.equal((await readMaterial(session, 'v4')).text.length, 'CURRENT_REQUIRED_BODY'.length * 2000);
});

test('working-memory checkpoints fold covered material revisions while retaining current truth and historical raw reasons', async () => {
  const { session, store } = await open({ workingMemory: memory });
  await session.updateMaterials([set('v1')]);
  await session.append([{ id: 'a', role: 'assistant', text: 'Former value: 12; the historical reason.' }]);
  await session.updateMaterials([set('v2', 'Current value: 15.')]);
  await session.append([{ id: 'u2', role: 'user', text: 'Continue' }, { id: 'a2', role: 'assistant', text: 'Continue' }, { id: 'u3', role: 'user', text: 'Latest input' }]);
  const state = await store.load(session.sessionId);
  await session.publishWorkingMemory(await memory.derive({ sessionId: session.sessionId, sourceRevision: state.revision, messages: state.messages.slice(0, 3), previous: null }));
  const prepared = await session.prepare(options());
  assert.equal(prepared.origin, 'working-memory');
  assert.equal(prepared.materialProjection.mode, 'checkpoint');
  assert.equal(materialMessages(prepared).length, 1);
  assert.match(materialMessages(prepared)[0].text, /Current value: 15/u);
  assert.match(prepared.messages[0].text, /former value was 12/u);
  assert.ok(prepared.messages.some((m) => m.id === 'u3'));
  assert.equal(prepared.usageBasis.checkpointId, prepared.checkpointId);
  assert.equal((await session.read({ sessionId: session.sessionId, startId: 'a', endId: 'a' }))[0].text, 'Former value: 12; the historical reason.');
  const ticket = await session.precomputeWorkingMemory({ throughId: 'u2' });
  await session.append([{ id: 'later', role: 'assistant', text: 'An appended response' }]);
  const adopted = await session.prepare(options({ workingMemoryTicket: ticket }));
  assert.ok(adopted.checkpointId);
  assert.equal((await store.load(session.sessionId)).version, 4);
});

test('capacity calibration is invalidated by actual material projection changes, including withdrawals', async () => {
  const { session } = await open();
  const opt = options({ model: { ...options().model, countTokens: () => 50 } });
  await session.updateMaterials([set('v1')]);
  const first = await session.prepare(opt);
  await session.append([{ id: 'a', role: 'assistant', text: 'Actual response' }], { expectedRevision: first.revision,
    usage: { basis: first.usageBasis, inputTokens: 140, outputTokens: 10 } });
  assert.equal((await session.prepare(opt)).budget.usageAdjustmentTokens, 90);
  await session.updateMaterials([withdraw('v2')]);
  assert.equal((await session.prepare(opt)).budget.usageAdjustmentTokens, 0);
});

const backend = { provider: 'fixture', endpoint: 'https://fixture.invalid', model: 'native-model', apiVersion: 'fixture-v1', scope: 'offline' };
for (const provider of ['openai', 'anthropic']) {
  test(`${provider} material changes explicitly rebuild native input; old checkpoints cannot claim a revision is effective`, async () => {
    const { session, store } = await open();
    const adapter = provider === 'openai'
      ? createOpenAINativeAdapter({ backend, mode: 'server-threshold', thresholdTokens: 500, countTokens: () => 20, generate: async () => undefined })
      : createAnthropicNativeAdapter({ backend, mode: 'server-threshold', thresholdTokens: 50_000, countTokens: () => 20, generate: async () => undefined });
    const opt = { ...options(), strategy: 'native', model: { ...options().model, backend: adapter.binding, nativeCompaction: confirmedNativeCapability(adapter, 'Offline fixture') } };
    const response = (id) => provider === 'openai' ? { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Historical reply' }] }] }
      : { id, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Historical reply' }] };
    const initial = await session.prepare(opt);
    await session.accept(initial, response('r0'));
    await session.updateMaterials([set('v1', 'Current value: 15.')]);
    const changed = await session.prepare(opt);
    assert.equal(changed.origin, 'rebuilt');
    assert.equal(changed.rebuildReason, 'fixed-input-changed');
    assert.equal(changed.checkpointId, null);
    assert.equal(changed.materialProjection.mode, 'current');
    assert.match(JSON.stringify(changed.request), /Current value: 15/u);
    assert.match(JSON.stringify(changed.request), /Keep this actual user input/u);
    await session.accept(changed, response('r1'));
    const resumed = await session.prepare(opt);
    assert.equal(resumed.origin, 'resumed');
    await session.updateMaterials([withdraw('v2')]);
    await assert.rejects(session.accept(resumed, response('stale-unaccepted')), conflict);
    const removed = await session.prepare(opt);
    assert.equal(removed.origin, 'rebuilt');
    assert.match(JSON.stringify(removed.request), /WITHDRAWN/u);
    assert.doesNotMatch(JSON.stringify(removed.request), /Current value: 15/u);
    await assert.rejects(session.accept(changed, response('stale')), /different content/u); // Previously accepted plan remains idempotent only for its own response.
    const saved = await store.load(session.sessionId);
    assert.equal(saved.nativeCheckpoints.length, 2);
    assert.equal(saved.materialRevisions.length, 2);
    const incomplete = response('incomplete');
    if (provider === 'openai') incomplete.output[0].content[0].annotations = [{ type: 'url_citation', url: 'https://fixture.invalid' }];
    else incomplete.content.push({ type: 'unknown-public-evidence', value: 'Original provider data' });
    await session.accept(removed, incomplete);
    await session.updateMaterials([set('v3')]);
    await assert.rejects(session.prepare(opt), (e) => e.code === 'NATIVE_MATERIALIZATION_REQUIRED');
  });
}

async function fileFixture(t, Store = FileStore) {
  const root = await temporaryDirectory(t, 'sw-material-');
  return { root, directory: path.join(root, createHash('sha256').update('materials').digest('hex')), store: new Store(root) };
}

test('FileStore upgrades only on material adoption and restores versions and exact projected order in another process', async (t) => {
  const fixture = await fileFixture(t), { session } = await open({ store: fixture.store });
  const manifestPath = path.join(fixture.directory, 'manifest.json');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, 1);
  const rawPath = path.join(fixture.directory, 'raw', 'u.json'), raw = await readFile(rawPath, 'utf8');
  await session.updateMaterials([set('v1')]);
  await session.append([{ id: 'a', role: 'assistant', text: 'Original reason' }]);
  await session.updateMaterials([withdraw('v2')]);
  const prepared = await session.prepare(options()), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, 5);
  assert.equal(await readFile(rawPath, 'utf8'), raw);
  const main = pathToFileURL(path.resolve('dist/index.js')).href, file = pathToFileURL(path.resolve('dist/file-store.js')).href;
  const code = `import {SessionWeave} from ${JSON.stringify(main)}; import {FileStore} from ${JSON.stringify(file)};
    const s=await SessionWeave.open({sessionId:'materials',store:new FileStore(${JSON.stringify(fixture.root)})});
    const c=await s.prepare({strategy:'portable',model:{id:'restored',contextWindow:100000,countTokens:()=>1},outputReserveTokens:100});
    console.log(JSON.stringify({messages:c.messages,original:await s.read({sessionId:s.sessionId,materialId:'reference',version:'v1'}),info:await s.inspect()}));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.deepEqual(restored.messages, prepared.messages);
  assert.equal(restored.original.text, 'Evidence v1');
  assert.equal(restored.info.materials[0].action, 'withdraw');
});

test('cancelled FileStore material persistence leaves an inactive orphan and a different retry can safely use the same sequence', async (t) => {
  const controller = new AbortController();
  class Interrupted extends FileStore {
    armed = false;
    async write(file, contents) { await super.write(file, contents); if (this.armed && path.basename(file).startsWith('manifest-')) controller.abort(); }
  }
  const fixture = await fileFixture(t, Interrupted), { session } = await open({ store: fixture.store });
  const before = await fixture.store.load(session.sessionId);
  fixture.store.armed = true;
  await assert.rejects(session.updateMaterials([set('v1')], { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fixture.store.load(session.sessionId), before);
  assert.equal((await readdir(path.join(fixture.directory, 'materials'))).length, 1);
  fixture.store.armed = false;
  await session.updateMaterials([set('different-version', 'Different actual content')]);
  assert.equal((await readdir(path.join(fixture.directory, 'materials'))).length, 2);
  assert.equal((await session.inspect()).materials[0].version, 'different-version');
});

test('FileStore material upgrades preserve older v4 provenance packages and later v5 memory adoption across restart', async (t) => {
  const fixture = await fileFixture(t), { session } = await open({ store: fixture.store, workingMemory: memory });
  await session.append([{ id: 'a', role: 'assistant', text: 'Historical response' }, { id: 'u2', role: 'user', text: 'Current request' }]);
  const first = await session.precomputeWorkingMemory({ throughId: 'a' });
  const prepared = await session.prepare(options({ workingMemoryTicket: first }));
  const manifestPath = path.join(fixture.directory, 'manifest.json');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, 4);
  const packagePath = path.join(fixture.directory, 'working-memory', `${prepared.checkpointId}.json`), original = await readFile(packagePath, 'utf8');
  await session.updateMaterials([set('v1')]);
  const second = await session.precomputeWorkingMemory({ throughId: 'a' });
  await session.append([{ id: 'a2', role: 'assistant', text: 'Appended after material source capture' }]);
  await session.prepare(options({ workingMemoryTicket: second }));
  await session.updateMaterials([withdraw('v2')]);
  const restored = await SessionWeave.open({ sessionId: session.sessionId, store: new FileStore(fixture.root) });
  assert.equal((await restored.inspect()).materials[0].action, 'withdraw');
  assert.equal((await fixture.store.load(session.sessionId)).workingMemoryCheckpoints.length, 2);
  assert.equal(await readFile(packagePath, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, 5);
});

test('committed material corruption or removal fails closed and material transactions cannot mix with raw messages', async (t) => {
  const fixture = await fileFixture(t), { session } = await open({ store: fixture.store });
  await session.updateMaterials([set('v1')]);
  const state = await fixture.store.load(session.sessionId), manifest = JSON.parse(await readFile(path.join(fixture.directory, 'manifest.json'), 'utf8'));
  const source = path.join(fixture.directory, 'materials', `${manifest.materialRevisions[0]}.json`), original = await readFile(source, 'utf8');
  await writeFile(source, original.replace('Evidence v1', 'Changed source'));
  await assert.rejects(fixture.store.load(session.sessionId), /content digest/u);
  await writeFile(source, original);
  await assert.rejects(fixture.store.commit(session.sessionId, state.revision, { materialRevisions: [{ ...state.materialRevisions[0], sequence: 2, revision: state.revision + 1 }], messages: [] }), /alone/u);
  await rm(source);
  await assert.rejects(fixture.store.load(session.sessionId), { code: 'ENOENT' });
});
