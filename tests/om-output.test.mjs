import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseObserverOutput, TokenCounter } from '@mastra/memory/processors';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { createOmWorkingMemory } from '../dist/om.js';
import { createOfflineOmModel } from '../examples/om-fixture.mjs';

const history = Array.from({ length: 8 }, (_, index) => ({ id: `o${index}`, role: index % 2 ? 'assistant' : 'user', text: `Recorded evidence ${index}` }));
const options = { strategy: 'portable', model: { id: 'actor', contextWindow: 1000, countTokens: (input) => input.messages.some((message) => message.synthetic === 'working-memory') ? 200 : 950 },
  outputReserveTokens: 100, safetyMarginTokens: 0, keepRecentGroups: 2 };
const xml = (observations) => `<observations>\n${observations}\n</observations>`;
// Engineering constructions for the real parser; these are not observed model failures.
const text = (seed) => `* PRIVATE_OUTPUT_BODY ${Array.from({ length: 180 }, (_, index) => createHash('sha256').update(`${seed}:${index}`).digest('hex')).join(' ')}`;
const short = '* A literal [truncated] marker is part of the recorded evidence.';
async function open(model, extra = {}) {
  const store = new MemoryStore(), workingMemory = createOmWorkingMemory({ model, modelId: 'fixture-output@1', observationTokens: 100_000, ...extra });
  const session = await SessionWeave.open({ sessionId: 'output-lines', store, workingMemory });
  await session.append(history);
  await session.prepare(options);
  return { session, store };
}
function outputError(stage) {
  return (error) => {
    assert.equal(error.code, 'OM_OUTPUT_TOO_LARGE');
    assert.match(error.message, new RegExp(`OM ${stage} parsed observations`));
    assert.match(error.message, /10,000 UTF-16 code units in one line/);
    assert.doesNotMatch(error.message, /PRIVATE_OUTPUT_BODY|\[truncated\]/);
    return true;
  };
}
const forceReflow = { ...options, model: { ...options.model, countTokens: () => 950 } };

test('Observer rejects real parser clipping at either UTF-16 cutoff and preserves the previous SW package', async () => {
  for (const astral of [false, true]) {
    const original = text(`observer-${astral}`);
    const oversized = astral ? `${original.slice(0, 9999)}😀${original.slice(9999)}` : original;
    const parsed = parseObserverOutput(xml(oversized));
    assert.equal(parsed.degenerate, undefined);
    assert.equal(parsed.observations.length, (astral ? 9999 : 10_000) + ' … [truncated]'.length);
    assert.ok(parsed.observations.endsWith(' … [truncated]'));
    const model = createOfflineOmModel({ output: ({ index }) => xml(index === 1 ? short : oversized) });
    const { session, store } = await open(model);
    await session.append([{ id: 'new-user', role: 'user', text: 'Later evidence' }, { id: 'new-reply', role: 'assistant', text: 'Later response' }]);
    const before = await store.load(session.sessionId);
    await assert.rejects(session.prepare(forceReflow), outputError('Observer'));
    assert.equal(model.calls.length, 2);
    assert.deepEqual(await store.load(session.sessionId), before);
  }
});

test('manual Reflector preserves the output error code and leaves the published SW package unchanged', async () => {
  const model = createOfflineOmModel({ output: ({ index }) => xml(index === 1 ? short : text('manual-reflection')) });
  const { session, store } = await open(model), before = await store.load(session.sessionId);
  await assert.rejects(session.prepare(forceReflow), outputError('Reflector'));
  assert.equal(model.calls.length, 2);
  assert.deepEqual(await store.load(session.sessionId), before);
});

test('automatic Reflector rejects an oversized parsed line after the isolated observation step', async () => {
  const observation = Array.from({ length: 8 }, (_, index) => text(`batch-${index}`).slice(0, 9000)).join('\n');
  const oversized = text('automatic-reflection'), counter = new TokenCounter();
  const observationTokens = counter.countObservations(parseObserverOutput(xml(oversized)).observations) + 100;
  assert.ok(counter.countObservations(observation) > observationTokens);
  assert.ok(counter.countObservations(parseObserverOutput(xml(oversized)).observations) < observationTokens);
  const model = createOfflineOmModel({ output: ({ index }) => xml(index === 1 ? short : index === 2 ? observation : oversized) });
  const { session, store } = await open(model, { observationTokens });
  await session.append([{ id: 'new-user', role: 'user', text: 'Later evidence' }, { id: 'new-reply', role: 'assistant', text: 'Later response' }]);
  const before = await store.load(session.sessionId);
  await assert.rejects(session.prepare(forceReflow), outputError('Reflector'));
  assert.equal(model.calls.length, 3);
  assert.deepEqual(await store.load(session.sessionId), before);
});

test('both real OM phases preserve short marker references and a line of exactly 10,000 UTF-16 units', async () => {
  const boundary = `${text('boundary').slice(0, 9998)}😀`, observations = `${short}\n${boundary}`;
  assert.equal(boundary.length, 10_000);
  const model = createOfflineOmModel({ output: () => xml(observations) });
  const { session, store } = await open(model);
  const first = await store.load(session.sessionId), original = first.messages;
  assert.equal(first.workingMemoryCheckpoints.at(-1).engineState.bundle.value.records[0].activeObservations, observations);
  let counts = 0;
  const prepared = await session.prepare({ ...options, model: { ...options.model, countTokens: () => ++counts === 1 ? 950 : 200 } });
  const saved = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: prepared.checkpointId });
  assert.equal(model.calls.length, 2);
  assert.equal(saved.engineState.bundle.value.records.find((row) => !row.supersededBy).activeObservations, observations);
  assert.deepEqual((await store.load(session.sessionId)).messages, original);
});

for (const specificationVersion of ['v2', 'v3', 'v4']) {
  for (const stage of ['Observer', 'automatic Reflector', 'manual Reflector']) {
    test(`${specificationVersion} ${stage} rejects length completion without replacing SW state or retrying`, async () => {
      // Closed XML can look parseable even when the provider reports an output limit.
      const partial = '* PRIVATE_OUTPUT_BODY parseable but length-terminated evidence.';
      assert.equal(parseObserverOutput(xml(partial)).observations, partial);
      const observation = Array.from({ length: 40 }, (_, index) => `* Evidence ${index}: ${createHash('sha256').update(String(index)).digest('hex')}`).join('\n');
      const automatic = stage === 'automatic Reflector', failedCall = automatic ? 3 : 2;
      const observationTokens = automatic ? 100 : 100_000;
      if (automatic) assert.ok(new TokenCounter().countObservations(observation) > observationTokens);
      const model = createOfflineOmModel({ specificationVersion,
        output: ({ index }) => xml(index === 1 ? short : automatic && index === 2 ? observation : partial),
        finishReason: ({ index }) => index !== failedCall ? 'stop' : specificationVersion === 'v2' ? 'length'
          : { unified: 'length', raw: 'fixture-output-cap' },
      });
      const { session, store } = await open(model, { observationTokens });
      if (stage !== 'manual Reflector') await session.append([
        { id: 'new-user', role: 'user', text: 'Later evidence' }, { id: 'new-reply', role: 'assistant', text: 'Later response' },
      ]);
      const before = await store.load(session.sessionId);
      await assert.rejects(session.prepare(forceReflow), (error) => {
        assert.equal(error.code, 'OM_OUTPUT_INCOMPLETE');
        assert.match(error.message, /finishReason "length"/);
        assert.doesNotMatch(error.message, /PRIVATE_OUTPUT_BODY|fixture-output-cap/);
        return true;
      });
      assert.equal(model.calls.length, failedCall);
      assert.deepEqual(await store.load(session.sessionId), before);
    });
  }

  test(`${specificationVersion} keeps SDK receivers, metadata and normal output; the host model remains independent`, async () => {
    const observations = '* A complete observation with a literal [truncated] reference.';
    const base = Object.freeze(createOfflineOmModel({ specificationVersion, output: () => xml(observations),
      finishReason: ({ index }) => specificationVersion === 'v2' ? index <= 2 ? 'stop' : 'length'
        : index <= 2 ? { unified: 'stop', raw: 'length' } : { unified: 'length', raw: 'fixture-output-cap' },
    }));
    const reads = new Set();
    class HostModel {
      #model = base;
      get specificationVersion() { return this.#model.specificationVersion; }
      get provider() { reads.add('provider'); return this.#model.provider; }
      get modelId() { reads.add('modelId'); return this.#model.modelId; }
      get supportedUrls() { reads.add('supportedUrls'); return this.#model.supportedUrls; }
      doGenerate(options) { return this.#model.doGenerate(options); }
      async doStream(options) {
        const result = await this.#model.doStream(options);
        // Public stream-result metadata can be non-enumerable getters as well.
        Object.defineProperties(result, {
          request: { get() { reads.add('request'); return { body: { fixture: true } }; } },
          response: { get() { reads.add('response'); return { headers: { 'x-fixture': 'offline' } }; } },
        });
        return Object.freeze(result);
      }
    }
    const model = new HostModel();
    Object.defineProperty(model, 'doStream', { value: model.doStream, writable: false, configurable: false });
    Object.freeze(model);
    const originalStream = model.doStream, originalGenerate = model.doGenerate;
    const descriptors = Object.getOwnPropertyDescriptors(model);
    const { session, store } = await open(model), first = await store.load(session.sessionId);
    let counts = 0;
    const prepared = await session.prepare({ ...options, model: { ...options.model, countTokens: () => ++counts === 1 ? 950 : 200 } });
    const saved = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: prepared.checkpointId });
    assert.equal(saved.engineState.bundle.value.records.find((row) => !row.supersededBy).activeObservations, observations);
    assert.equal(base.calls.length, 2);
    assert.deepEqual((await store.load(session.sessionId)).messages, first.messages);
    for (const key of ['provider', 'modelId', 'supportedUrls', 'request', 'response']) assert.ok(reads.has(key));
    assert.equal(model.doStream, originalStream);
    assert.equal(model.doGenerate, originalGenerate);
    assert.deepEqual(Object.getOwnPropertyDescriptors(model), descriptors);
    // A host/actor call on the original model still receives the original finish event.
    const result = await model.doStream({ prompt: [] }), chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(specificationVersion === 'v2' ? chunks.at(-1).finishReason : chunks.at(-1).finishReason.unified, 'length');
    assert.equal(base.calls.length, 3);
  });
}
