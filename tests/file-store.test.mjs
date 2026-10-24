import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';

async function fixture(t) {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, 'sessionweave-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('sessionweave-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store: new FileStore(root), directory: (id) => path.join(root, createHash('sha256').update(id).digest('hex')) };
}
const simpleModel = { id: 'test', contextWindow: 100000, countTokens: () => 1 };

test('file store restores the explicit session in a new process without replaying tools', async (t) => {
  const { root, store } = await fixture(t);
  const session = await SessionWeave.open({ sessionId: 'specific', store });
  await session.append([
    { id: 'u', role: 'user', text: 'Read original' },
    { id: 'a', role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'read', arguments: {} }] },
    { id: 'r', role: 'tool', callId: 'call', name: 'read', text: 'Actual stored result', isError: false },
  ]);
  const module = pathToFileURL(path.resolve('dist/index.js')).href;
  const files = pathToFileURL(path.resolve('dist/file-store.js')).href;
  const code = `import {SessionWeave} from ${JSON.stringify(module)}; import {FileStore} from ${JSON.stringify(files)};
const s = await SessionWeave.open({sessionId:'specific',store:new FileStore(${JSON.stringify(root)}),summarizer:{summarize(){throw Error('must not summarize on restore')}}});
const c = await s.prepare({model:{id:'restored/model',contextWindow:10000,countTokens:()=>1},outputReserveTokens:100});
console.log(JSON.stringify({status:await s.inspect(),messages:c.messages}));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.equal(restored.status.messageCount, 3);
  assert.equal(restored.messages.at(-1).text, 'Actual stored result');
  assert.equal(restored.status.revision, 1);
  assert.deepEqual(await session.inspect(), restored.status);
});

test('independent file-store handles serialize or reject concurrent writes without losses', async (t) => {
  const { root, store } = await fixture(t);
  const one = await SessionWeave.open({ sessionId: 'same', store });
  const two = await SessionWeave.open({ sessionId: 'same', store: new FileStore(root) });
  const results = await Promise.allSettled([
    one.append([{ id: 'one', role: 'user', text: 'One' }]), two.append([{ id: 'two', role: 'user', text: 'Two' }]),
  ]);
  const count = results.filter((result) => result.status === 'fulfilled').length;
  assert.ok(count >= 1);
  assert.equal((await one.inspect()).messageCount, count);
});

test('unreferenced interrupted-write artifacts are ignored; missing committed raw records are errors', async (t) => {
  const { store, directory } = await fixture(t);
  const session = await SessionWeave.open({ sessionId: 'orphan', store });
  await session.append([{ id: 'committed', role: 'user', text: 'Keep' }]);
  const raw = path.join(directory('orphan'), 'raw');
  await writeFile(path.join(raw, 'orphan.json'), 'incomplete abandoned write');
  assert.equal((await session.inspect()).messageCount, 1);
  await rm(path.join(raw, 'committed.json'));
  await assert.rejects(SessionWeave.open({ sessionId: 'orphan', store }), /ENOENT/u);
});

test('corrupt manifests are reported, and stale locks never cause silent overwrites', async (t) => {
  const { store, directory } = await fixture(t);
  const session = await SessionWeave.open({ sessionId: 'locked', store });
  await session.append([{ id: 'one', role: 'user', text: 'Keep' }]);
  await mkdir(path.join(directory('locked'), 'write.lock'));
  await assert.rejects(session.append([{ role: 'user', text: 'Second' }]), (error) => error.code === 'STORE_BUSY');
  assert.equal((await session.inspect()).messageCount, 1);
  await writeFile(path.join(directory('locked'), 'manifest.json'), '{incomplete');
  await assert.rejects(session.inspect(), SyntaxError);
});

test('host session identifiers cannot escape the storage directory', async (t) => {
  const { root, store } = await fixture(t);
  const session = await SessionWeave.open({ sessionId: '../../host/session', store });
  await session.append([{ role: 'user', text: 'Safe location' }]);
  const children = await readdir(root);
  assert.equal(children.length, 1);
  assert.match(children[0], /^[a-f0-9]{64}$/u);
});

test('checkpoint publication leaves separate immutable raw files unchanged', async (t) => {
  const { store, directory, root } = await fixture(t);
  const summaryModel = { id: 'summary', contextWindow: 100000, countTokens: () => 1 };
  const summarizer = { model: summaryModel, outputReserveTokens: 100,
    summarize: async (request) => ({ complete: true, throughId: request.throughId, handoff: {
      version: 1, goals: [{ text: 'Continue', refs: [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.throughId }] }],
      constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [],
    } }),
  };
  const session = await SessionWeave.open({ sessionId: 'checkpoint', store, summarizer });
  for (let index = 0; index < 6; index++) await session.append([{ id: `u${index}`, role: 'user', text: 'Text' }, { id: `a${index}`, role: 'assistant', text: 'Reply' }]);
  const rawFile = path.join(directory('checkpoint'), 'raw/u0.json');
  const bytes = await readFile(rawFile), before = await stat(rawFile);
  const counter = (input) => input.messages.length * 20;
  const context = await session.prepare({ model: { id: 'small', contextWindow: 240, countTokens: counter }, outputReserveTokens: 40 });
  assert.ok(context.checkpointId);
  assert.equal((await readdir(path.join(directory('checkpoint'), 'checkpoints'))).length, 1);
  assert.deepEqual(await readFile(rawFile), bytes);
  assert.equal((await stat(rawFile)).mtimeMs, before.mtimeMs);
  const restored = await SessionWeave.open({ sessionId: 'checkpoint', store: new FileStore(root), summarizer });
  assert.equal((await restored.inspect()).checkpoint.id, context.checkpointId);
  assert.equal((await restored.prepare({ model: simpleModel, outputReserveTokens: 100 })).messages[0].synthetic, 'handoff');
});
