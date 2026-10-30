import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';

const inputs = [
  { id: 'u', role: 'user', text: 'Question 💡 with newline\nand quoted "evidence". '.repeat(18) },
  { id: 'a', role: 'assistant', text: '', toolCalls: [{ id: 'operation', name: 'host_read', arguments: { huge: '嵌套💡\\quoted\n'.repeat(100), value: 0.08, unit: 'mg' } }] },
  { id: 't', role: 'tool', callId: 'operation', name: 'host_read', text: '完整结果😀 unknown\n'.repeat(150), isError: false },
];
const reference = { sessionId: 'pages', startId: 'u', endId: 't' };
const count = (page) => Buffer.byteLength(JSON.stringify({ tool_call_id: 'present-read-1', name: 'read_original', result: page, isError: false }), 'utf8');
const options = { maxTokens: 1600, countTokens: count };
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort()) : item);
const cursorWith = (cursor, changes) => Buffer.from(canonical({ ...JSON.parse(Buffer.from(cursor, 'base64url')), ...changes })).toString('base64url');
async function open(store = new MemoryStore()) {
  const session = await SessionWeave.open({ sessionId: 'pages', store });
  await session.append(inputs);
  return { session, store };
}
async function collect(session, range, extra = {}, initial = []) {
  const pages = [...initial];
  for (let index = 0; index < 200; index++) {
    const previous = pages.at(-1);
    if (previous?.done) return pages;
    const page = await session.readPage(range, { ...options, ...extra, ...(previous ? { cursor: previous.nextCursor } : {}) });
    assert.ok(count(page) <= (extra.maxTokens ?? options.maxTokens));
    pages.push(page);
  }
  assert.fail('Reader did not finish within the fixture bound.');
}
function reconstruct(pages, messages) {
  for (const message of messages) {
    const fragments = pages.filter((page) => page.source.startId === message.id);
    assert.ok(fragments.length > 0);
    let offset = 0;
    for (const page of fragments) {
      assert.equal(page.sequence, message.sequence);
      assert.deepEqual(page.source, { sessionId: 'pages', startId: message.id, endId: message.id });
      assert.equal(page.position.unit, 'utf16-code-unit');
      assert.equal(page.position.start, offset);
      assert.equal(page.position.end - offset, page.text.length);
      assert.ok(page.text.length > 0);
      assert.equal(page.position.total, canonical(message).length);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(page.text));
      offset = page.position.end;
    }
    assert.equal(offset, canonical(message).length);
    assert.deepEqual(JSON.parse(fragments.map((page) => page.text).join('')), message);
  }
}
test('complete records, long JSON tool arguments and results reconstruct exactly from fully budgeted pages', async () => {
  const { session, store } = await open(), before = await store.load('pages');
  const pages = await collect(session, reference);
  assert.ok(pages.length > inputs.length);
  assert.ok(pages.every((page) => canonical(page.range) === canonical(reference) && page.format === 'sessionweave-message-json@1'));
  assert.equal(new Set(pages.map((page) => page.rangeDigest)).size, 1);
  assert.ok(pages.slice(0, -1).every((page) => !page.done && typeof page.nextCursor === 'string'));
  assert.equal(pages.at(-1).done, true);
  assert.equal(pages.at(-1).nextCursor, null);
  reconstruct(pages, before.messages);
  assert.deepEqual(await store.load('pages'), before);
});
test('new appends and reopening do not invalidate an existing immutable range cursor', async () => {
  const { session, store } = await open();
  const first = await session.readPage(reference, options);
  await session.append([{ id: 'later', role: 'user', text: 'New history outside the selected range.' }]);
  const reopened = await SessionWeave.open({ sessionId: 'pages', store });
  const pages = await collect(reopened, reference, {}, [JSON.parse(JSON.stringify(first))]);
  assert.ok(pages.every((page) => page.rangeDigest === first.rangeDigest));
  assert.ok(pages.every((page) => page.source.endId !== 'later'));
  reconstruct(pages, await session.read(reference));
});
test('cursors reject other ranges, content identities, invalid offsets and offsets splitting a surrogate pair', async () => {
  const { session } = await open(), first = await session.readPage(reference, options);
  for (const cursor of ['', 'not:base64', 'a'.repeat(1025), cursorWith(first.nextCursor, { digest: 'f'.repeat(64) }),
    cursorWith(first.nextCursor, { offset: 999999 }), cursorWith(first.nextCursor, { version: 2 }), cursorWith(first.nextCursor, { offset: canonical((await session.read(reference))[0]).indexOf('💡') + 1 })]) {
    await assert.rejects(session.readPage(reference, { ...options, cursor }), (error) => error.code === 'INVALID_READ_CURSOR');
  }
  await assert.rejects(session.readPage({ ...reference, endId: 'u' }, { ...options, cursor: first.nextCursor }), (error) => error.code === 'INVALID_READ_CURSOR');
  await assert.rejects(session.readPage({ ...reference, nativeCheckpointId: 'extra' }, options), /explicit raw range/);
  const sameIdsOtherContent = { supportsWorkingMemoryState: true, async load() {
    return { version: 1, sessionId: 'pages', revision: 1, messages: (await session.read(reference)).map((message, index) => index ? message : { ...message, text: 'Changed source content' }), checkpoints: [], usage: [] };
  }, async commit() { throw Error('read only'); } };
  const changed = await SessionWeave.open({ sessionId: 'pages', store: sameIdsOtherContent });
  await assert.rejects(changed.readPage(reference, { ...options, cursor: first.nextCursor }), (error) => error.code === 'INVALID_READ_CURSOR');
});
test('metadata, continuation and actual tool envelope count toward the budget; no minimal fit is an explicit failure', async () => {
  const { session, store } = await open(), before = await store.load('pages');
  await assert.rejects(session.readPage(reference, { ...options, maxTokens: 1 }), (error) => error.code === 'CONTEXT_BUDGET');
  const page = await session.readPage(reference, { maxTokens: 2000, countTokens: (candidate) => count(candidate) + 900 });
  assert.ok(count(page) + 900 <= 2000);
  assert.deepEqual(await store.load('pages'), before);
});
test('returned candidates are actual counted fits even with a nonmonotonic counter or mutations of counter copies', async () => {
  const { session } = await open();
  const nonlinear = (page) => count(page) - (page.text.length % 7) * 3;
  const counted = [];
  const page = await session.readPage(reference, { maxTokens: 1400, countTokens(candidate) {
    counted.push(canonical(candidate));
    const result = nonlinear(candidate);
    candidate.text = 'Mutated counter copy'; candidate.source.startId = 'fake';
    return result;
  } });
  assert.ok(nonlinear(page) <= 1400);
  assert.ok(counted.includes(canonical(page)));
  assert.doesNotMatch(page.text, /Mutated counter/);
  assert.equal(page.source.startId, 'u');
});
test('options and reference are captured before storage awaits; cancellation and invalid counts publish nothing', async () => {
  const { session, store } = await open(), range = { ...reference }, settings = { ...options };
  const pending = session.readPage(range, settings);
  range.endId = 'missing'; settings.cursor = 'invalid'; settings.maxTokens = 0; settings.countTokens = () => { throw Error('changed'); };
  assert.deepEqual((await pending).range, reference);
  const before = await store.load('pages');
  const controller = new AbortController();
  await assert.rejects(session.readPage(reference, { ...options, signal: controller.signal, countTokens() { controller.abort(); return 0; } }), (error) => error.name === 'AbortError');
  for (const value of [NaN, -1, 1.5]) await assert.rejects(session.readPage(reference, { ...options, countTokens: () => value }), /nonnegative safe integer/);
  assert.deepEqual(await store.load('pages'), before);
});
test('a large record remains resumable above the per-page rendering bound and terminal metadata is fully counted', async () => {
  const session = await SessionWeave.open({ sessionId: 'pages', store: new MemoryStore() });
  await session.append([{ id: 'large', role: 'user', text: '💡'.repeat(35_000) }]);
  const range = { sessionId: 'pages', startId: 'large', endId: 'large' };
  const pages = await collect(session, range, { maxTokens: 1_000_000 });
  assert.equal(pages.length, 2);
  assert.ok(pages[0].text.length <= 65_536);
  reconstruct(pages, await session.read(range));
  const terminal = await session.readPage(range, { maxTokens: 1, cursor: pages[0].nextCursor, countTokens: (page) => page.done ? 1 : 2 });
  assert.equal(terminal.done, true);
});
test('a cursor continues in a new process without any engine, provider or revision token', async (t) => {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, 'sw-raw-pages-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('sw-raw-pages-'));
    await rm(root, { recursive: true, force: true });
  });
  const { session } = await open(new FileStore(root));
  const first = await session.readPage(reference, options);
  await session.append([{ id: 'new', role: 'user', text: 'Append without invalidating the old range.' }]);
  const source = `
    import {SessionWeave} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    import {FileStore} from ${JSON.stringify(new URL('../dist/file-store.js', import.meta.url).href)};
    const session=await SessionWeave.open({sessionId:'pages',store:new FileStore(${JSON.stringify(root)})});
    const reference=${JSON.stringify(reference)}, pages=[${JSON.stringify(first)}];
    while(!pages.at(-1).done) pages.push(await session.readPage(reference,{cursor:pages.at(-1).nextCursor,maxTokens:1600,countTokens:page=>Buffer.byteLength(JSON.stringify({tool_call_id:'present-read-1',name:'read_original',result:page,isError:false}),'utf8')}));
    console.log(JSON.stringify(pages));
  `;
  const pages = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' }));
  reconstruct(pages, await session.read(reference));
  assert.ok(pages.every((page) => count(page) <= options.maxTokens));
});
