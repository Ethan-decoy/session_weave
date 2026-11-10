import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getModelCallContext, createJsonSummarizer, MemoryStore, SessionWeave } from '../dist/index.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOpenAINativeAdapter, confirmedNativeCapability } from '../dist/native-adapters.js';
import { observeOmModel, observePiStream, observeTransport } from '../examples/usage-observation.mjs';
import { createOfflineOmModel } from '../examples/om-fixture.mjs';

const raw = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `Actual evidence ${i}` }));
const options = { strategy: 'portable', model: { id: 'actor', contextWindow: 1000, countTokens: (input) => input.messages.some((m) => m.synthetic === 'working-memory' || m.synthetic === 'handoff') ? 200 : 950 }, outputReserveTokens: 100, safetyMarginTokens: 0 };
const xml = (text) => `<observations>\n${text}\n</observations>`;
const short = '* Condensed evidence with original historical reasons.';
const long = Array.from({ length: 40 }, (_, i) => `* Evidence ${i}: a distinct recorded measurement, identifier and unresolved question.`).join('\n');
async function open(workingMemory, sessionId = 'usage', extra = {}) {
  const store = new MemoryStore(), session = await SessionWeave.open({ sessionId, store, ...(workingMemory ? { workingMemory } : {}), ...extra });
  await session.append(raw);
  return { session, store };
}

for (const specificationVersion of ['v2', 'v3', 'v4']) {
  test(`${specificationVersion} actual SDK usage reaches host wrappers for Observer and automatic/manual Reflector without a second ledger`, async () => {
    const usage = specificationVersion === 'v2' ? { inputTokens: 100, outputTokens: 8, cacheReadTokens: 70 }
      : { inputTokens: { total: 100, cacheRead: 70 }, outputTokens: { total: 8, reasoning: 3 } };
    const records = [], base = createOfflineOmModel({ specificationVersion, output: ({ index }) => xml(index === 1 ? long : short) });
    const actual = Object.freeze({ ...base, async doStream(input) {
      const result = await base.doStream(input);
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
        controller.enqueue(chunk.type === 'finish' ? { ...chunk, usage } : chunk);
      } })) };
    } });
    const workingMemory = createOmWorkingMemory({ model: observeOmModel(actual, (record) => records.push(record)), modelId: 'fixture/model-settings@1', observationTokens: 100 });
    const { session, store } = await open(workingMemory);
    await session.prepare(options);
    assert.deepEqual(records.map((r) => r.call.phase), ['observer', 'reflector']);
    let counts = 0;
    const before = await store.load(session.sessionId), prepared = await session.prepare({ ...options, model: { ...options.model, countTokens: () => ++counts === 1 ? 950 : 200 } });
    assert.deepEqual(records.map((r) => r.call.phase), ['observer', 'reflector', 'reflector']);
    assert.equal(new Set(records.map((r) => r.call.callId)).size, 3);
    for (const record of records) {
      assert.equal(record.call.sessionId, session.sessionId);
      assert.equal(record.call.modelId, 'fixture/model-settings@1');
      assert.equal(record.model.id, 'offline-om');
      assert.equal(record.status, 'succeeded');
      assert.deepEqual(record.usage, usage);
      assert.equal(Object.hasOwn(specificationVersion === 'v2' ? record.usage : record.usage.inputTokens, 'cacheWrite'), false);
    }
    assert.equal(records[2].call.checkpointId, before.workingMemoryCheckpoints.at(-1).id);
    assert.equal(records[2].call.sourceRevision, before.revision);
    assert.equal(records[2].call.throughId, before.workingMemoryCheckpoints.at(-1).sourceThroughId);
    assert.notEqual(records[2].call.checkpointId, prepared.checkpointId);
    assert.equal((await store.load(session.sessionId)).usage.length, 0); // No fabricated actor calibration / billing commits.
    assert.equal(getModelCallContext(), undefined);
    assert.doesNotMatch(JSON.stringify(records), /Actual evidence|observations>|supportedUrls|headers/u);
  });
}

test('usage already returned by a length-terminated Observer survives rejected memory publication', async () => {
  const records = [], fixture = createOfflineOmModel({ finishReason: 'length', output: () => xml(short) });
  const workingMemory = createOmWorkingMemory({ model: observeOmModel(fixture, (record) => records.push(record)), modelId: 'fixture@1' });
  const { session, store } = await open(workingMemory), before = await store.load(session.sessionId);
  await assert.rejects(session.prepare(options), (error) => error.code === 'OM_OUTPUT_INCOMPLETE');
  assert.deepEqual(await store.load(session.sessionId), before);
  assert.equal(records.length, 1);
  assert.equal(records[0].finishReason, 'length');
  assert.equal(records[0].status, 'failed');
  assert.equal(records[0].usage.inputTokens, 20);
  assert.equal(records[0].call.phase, 'observer');
});

test('Observer usage remains observable when cancellation prevents publication and abort reaches the injected model', async () => {
  const controller = new AbortController(), records = [], fixture = createOfflineOmModel();
  let injectedSignal;
  const model = { ...fixture, async doStream(input) { injectedSignal = input.abortSignal; return fixture.doStream(input); } };
  const workingMemory = createOmWorkingMemory({ model: observeOmModel(model, (record) => { records.push(record); controller.abort(); }), modelId: 'fixture@1' });
  const { session, store } = await open(workingMemory), before = await store.load(session.sessionId);
  await assert.rejects(session.prepare({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(injectedSignal.aborted, true);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].usage, { inputTokens: 20, outputTokens: 30, totalTokens: 50 });
  assert.deepEqual(await store.load(session.sessionId), before);
});

test('native compact wrappers preserve vendor cache fields, correlation and usage even if the final candidate cannot fit', async () => {
  const records = [], usage = { input_tokens: 900, input_tokens_details: { cached_tokens: 700 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } };
  const adapter = createOpenAINativeAdapter({ backend: { provider: 'fixture', endpoint: 'https://fixture.invalid', model: 'native', apiVersion: 'fixture-v1', scope: 'offline' },
    mode: 'on-demand', generate: async () => undefined,
    compact: observeTransport(async () => ({ id: 'compact1', object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: 'opaque' }], usage }), (record) => records.push(record)),
    countTokens: (request) => request.body.input.some((entry) => entry.type === 'compaction') ? 950 : 850 });
  const { session, store } = await open(null), before = await store.load(session.sessionId);
  await assert.rejects(session.prepare({ ...options, strategy: 'native', model: { ...options.model, backend: adapter.binding, nativeCompaction: confirmedNativeCapability(adapter, 'Fixture') } }), (error) => error.code === 'CONTEXT_BUDGET');
  assert.deepEqual(await store.load(session.sessionId), before);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].usage, usage);
  assert.equal(records[0].call.phase, 'native-compaction');
  assert.equal(records[0].call.sessionId, session.sessionId);
  assert.equal(records[0].call.sourceRevision, before.revision);
  assert.equal(records[0].call.checkpointId, null);
  assert.equal(records[0].call.throughId, raw.at(-1).id);
});

test('summary transports see metadata and raw usage before invalid JSON or a revision conflict discards a candidate', async () => {
  const records = [], usage = { input: 80, cacheRead: 20, output: 10 };
  let invalid = true, session;
  const transport = observeTransport(async () => {
    await new Promise((done) => setImmediate(done));
    assert.equal(getModelCallContext().phase, 'summary');
    if (!invalid) await session.updateMaterials([{ id: 'source', version: 'v1', action: 'set', text: 'New actual source' }]);
    const ref = { sessionId: session.sessionId, startId: 'm0', endId: 'm5' };
    return { usage, complete: true, text: invalid ? '{broken' : JSON.stringify({ complete: true, throughId: 'm5', handoff: { version: 1,
      goals: [{ text: 'Historical work', refs: [ref] }], constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [] } }) };
  }, (record) => records.push(record));
  const summarizer = createJsonSummarizer({ model: { id: 'summary/model', contextWindow: 100_000, countTokens: () => 10 }, outputReserveTokens: 500,
    generate: (input, options) => transport(input, options.signal) });
  const fixture = await open(null, 'summary-usage', { summarizer }); session = fixture.session;
  const before = await fixture.store.load(session.sessionId);
  await assert.rejects(session.prepare(options), SyntaxError);
  assert.deepEqual(await fixture.store.load(session.sessionId), before);
  invalid = false;
  await assert.rejects(session.prepare(options), (error) => error.code === 'REVISION_CONFLICT');
  assert.equal((await fixture.store.load(session.sessionId)).checkpoints.length, 0);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.call.phase === 'summary' && r.call.modelId === 'summary/model' && r.call.sourceRevision === before.revision));
  assert.ok(records.every((r) => r.status === 'succeeded'));
  assert.deepEqual(records.map((r) => r.usage), [usage, usage]);
});

test('transport failures/cancellations preserve partial actual usage, omit unknown fields and retain the original error', async () => {
  const records = [], controller = new AbortController(), failure = Object.assign(Error('PRIVATE_BODY and credentials must not be logged'), { usage: { cache_read_input_tokens: 15 } });
  const failed = observeTransport(async () => { throw failure; }, (record) => records.push(record));
  await assert.rejects(failed({}, undefined), (error) => error === failure);
  const aborted = observeTransport(async () => { controller.abort(); return { usage: { input_tokens: 18 } }; }, (record) => records.push(record));
  assert.deepEqual(await aborted({}, controller.signal), { usage: { input_tokens: 18 } });
  await assert.rejects(observeTransport(async () => { throw new Error('No response'); }, (record) => records.push(record))({}), /No response/u);
  assert.deepEqual(records.map((r) => r.status), ['failed', 'cancelled', 'failed']);
  assert.deepEqual(records[0].usage, { cache_read_input_tokens: 15 });
  assert.deepEqual(records[1].usage, { input_tokens: 18 });
  assert.equal(Object.hasOwn(records[2], 'usage'), false);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BODY|credentials|output_tokens/u);
  const result = await observeTransport(async () => ({ usage: { input_tokens: 1 }, exact: true }), () => { throw Error('observer failed'); })({});
  assert.equal(result.exact, true);
  await observeTransport(async () => ({ status: 'failed', usage: { output_tokens: 3 } }), (record) => records.push(record))({});
  assert.equal(records.at(-1).status, 'failed');
  assert.deepEqual(records.at(-1).usage, { output_tokens: 3 });
  assert.equal((await observeTransport(async () => ({ exact: true }), () => undefined, { usageOf() { throw Error('Bad extractor'); } })({})).exact, true);
});

test('SDK stream failures and consumer cancellation are observable without inventing usage or consuming the stream twice', async () => {
  const records = [], error = Object.assign(Error('PRIVATE_STREAM'), { usage: { inputTokens: 7 } });
  const model = { specificationVersion: 'v2', provider: 'fixture', modelId: 'stream', async doStream() {
    return { stream: new ReadableStream({ pull(controller) { controller.error(error); } }) };
  } };
  const wrapped = observeOmModel(model, (record) => records.push(record));
  const failed = await wrapped.doStream({});
  await assert.rejects(failed.stream.getReader().read(), (reason) => reason === error);
  let cancelledUnderlying = false;
  const streaming = observeOmModel({ ...model, async doStream() { return { stream: new ReadableStream({ cancel() { cancelledUnderlying = true; } }) }; } }, (record) => records.push(record));
  await (await streaming.doStream({})).stream.cancel();
  assert.equal(cancelledUnderlying, true);
  assert.deepEqual(records.map((r) => r.status), ['failed', 'cancelled']);
  assert.deepEqual(records[0].usage, { inputTokens: 7 });
  assert.equal(Object.hasOwn(records[1], 'usage'), false);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_STREAM/u);
});

test('an SDK error part followed by finish retains the final vendor usage and a failed outcome', async () => {
  const records = [], usage = { inputTokens: 17, outputTokens: 2 };
  const model = observeOmModel({ specificationVersion: 'v2', provider: 'fixture', modelId: 'error-then-usage', async doStream() {
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'error', error: Error('PRIVATE_BODY') });
      controller.enqueue({ type: 'finish', finishReason: 'error', usage }); controller.close();
    } }) };
  } }, (record) => records.push(record));
  for await (const _chunk of (await model.doStream({})).stream) { /* Consume the original protocol. */ }
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
  assert.deepEqual(records[0].usage, usage);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BODY/u);
});

test('concurrent sessions and interleaved streams retain separate captured call scopes', async () => {
  const records = [], fixture = createOfflineOmModel({ onCall: async () => new Promise((done) => setImmediate(done)) });
  const model = observeOmModel(fixture, (record) => records.push(record));
  const a = await open(createOmWorkingMemory({ model, modelId: 'fixture@1' }), 'session-A');
  const b = await open(createOmWorkingMemory({ model, modelId: 'fixture@1' }), 'session-B');
  await Promise.all([a.session.precomputeWorkingMemory({ throughId: 'm3' }), b.session.precomputeWorkingMemory({ throughId: 'm5' })]);
  assert.deepEqual(records.map((r) => [r.call.sessionId, r.call.throughId]), [['session-A', 'm3'], ['session-B', 'm5']]);
  assert.equal(new Set(records.map((r) => r.call.callId)).size, 2);
  assert.equal(getModelCallContext(), undefined);
  assert.equal((await a.store.load(a.session.sessionId)).workingMemoryCheckpoints.length, 0);
  assert.equal((await b.store.load(b.session.sessionId)).workingMemoryCheckpoints.length, 0);
});

test('Pi observation preserves separate input/cache usage before an SDK bridge merges fields or rejects an error', async () => {
  const usage = { input: 40, cacheRead: 70, cacheWrite: 5, output: 8, totalTokens: 123 };
  for (const stopReason of ['stop', 'error']) {
    const records = [], response = { stopReason, usage }, result = Promise.resolve(response);
    let consumed = 0;
    const upstream = { result() { return result; }, async *[Symbol.asyncIterator]() { consumed++; yield { type: 'text_delta', delta: 'PRIVATE_BODY' }; } };
    const stream = observePiStream(() => upstream, (record) => records.push(record));
    const fixture = createOfflineOmModel({ async onCall() {
      const actual = stream();
      assert.equal(actual, upstream);
      assert.equal(consumed, 0); // The observation attaches to the result promise, not the iterator.
      for await (const _event of actual) { /* Existing bridge consumes the original events once. */ }
      const final = await actual.result();
      if (final.stopReason === 'error') throw Error('Bridge rejected the response before an SDK finish');
    } });
    const { session, store } = await open(createOmWorkingMemory({ model: fixture, modelId: 'pi/bridge@1' })), before = await store.load(session.sessionId);
    if (stopReason === 'error') {
      await assert.rejects(session.prepare(options));
      assert.deepEqual(await store.load(session.sessionId), before);
    } else await session.prepare(options);
    assert.equal(records.length, 1);
    assert.equal(records[0].call.phase, 'observer');
    assert.equal(records[0].usageSource, 'pi-sdk');
    assert.equal(records[0].status, stopReason === 'stop' ? 'succeeded' : 'failed');
    assert.deepEqual(records[0].usage, usage);
    assert.equal(consumed, 1);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BODY/u);
  }
});

test('late Pi usage after an early bridge cancellation survives without an SDK finish or a committed message', async () => {
  const records = [], controller = new AbortController();
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const upstream = { result() { return result; }, async *[Symbol.asyncIterator]() { throw Error('Observation must not consume this stream'); } };
  const stream = observePiStream(() => upstream, (record) => records.push(record), { signal: controller.signal });
  const fixture = createOfflineOmModel({ onCall() { stream(); controller.abort(); throw new DOMException('Bridge cancelled', 'AbortError'); } });
  const { session, store } = await open(createOmWorkingMemory({ model: fixture, modelId: 'pi/bridge@1' })), before = await store.load(session.sessionId);
  await assert.rejects(session.prepare({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(records.length, 0);
  const usage = { input: 10, cacheRead: 40, cacheWrite: 3, output: 2 };
  finish({ stopReason: 'aborted', usage });
  await result; await Promise.resolve();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'cancelled');
  assert.equal(records[0].call.phase, 'observer');
  assert.equal(records[0].call.sessionId, session.sessionId);
  assert.deepEqual(records[0].usage, usage);
  assert.deepEqual(await store.load(session.sessionId), before);
});
