import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionWeave, MemoryStore, ContextBudgetError, createJsonSummarizer } from '../dist/index.js';

export const tokenCount = (input) => Math.ceil((input.systemPrompt.length + JSON.stringify(input.tools).length
  + input.messages.reduce((total, message) => total + message.text.length + JSON.stringify(message.role === 'assistant' ? message.toolCalls ?? [] : []).length + 20, 0)) / 4);
export const model = (contextWindow = 900, id = 'test/model/counter-v1') => ({ id, contextWindow, maxOutputTokens: 4000, countTokens: tokenCount });
export const options = (extra = {}) => ({ strategy: 'portable', model: model(), outputReserveTokens: 100, ...extra });
export function summary(request) {
  return { complete: true, throughId: request.throughId, handoff: {
    version: 1,
    goals: [{ text: 'Continue the requested work.', refs: [{ sessionId: request.sessionId, startId: request.previous?.goals[0]?.refs[0]?.startId ?? request.messages[0].id, endId: request.throughId }] }],
    constraints: request.previous?.constraints ?? [], decisions: [], completed: [], openQuestions: [], corrections: [],
  } };
}
export const summarizer = (generate = async (request) => summary(request), profile = model(20000, 'summary/model')) => ({ model: profile, outputReserveTokens: 2000, summarize: generate });
export async function history(session, count = 6, length = 260, prefix = 'm') {
  for (let index = 0; index < count; index++) await session.append([
    { id: `${prefix}-u${index}`, role: 'user', text: 'u'.repeat(length) },
    { id: `${prefix}-a${index}`, role: 'assistant', text: 'a'.repeat(length) },
  ]);
}
const open = async (extra = {}) => SessionWeave.open({ sessionId: 'explicit-session', store: new MemoryStore(), ...extra });

test('explicit identity, atomic append, stable raw references and defensive copies', async () => {
  await assert.rejects(open({ sessionId: '' }), /explicit session/u);
  const store = new MemoryStore(), session = await open({ store });
  const input = { id: 'user', role: 'user', text: 'Original' };
  await session.append([input]); input.text = 'Changed outside';
  const reference = { sessionId: session.sessionId, startId: 'user', endId: 'user' };
  const [raw] = await session.read(reference);
  assert.equal(raw.text, 'Original'); raw.text = 'Mutated read';
  assert.equal((await session.read(reference))[0].text, 'Original');
  await assert.rejects(session.append([{ role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'read', arguments: {} }] }, { role: 'user', text: 'Interrupt' }]), /tool results/u);
  assert.equal((await store.load(session.sessionId)).messages.length, 1);
  await assert.rejects(session.read({ ...reference, sessionId: 'other' }), /another session/u);
});

test('idempotent whole-batch replay accepts equivalent JSON and refuses changes or partial replay', async () => {
  const session = await open();
  await session.append([{ id: 'one', role: 'user', text: 'Question' }]);
  assert.equal((await session.append([{ text: 'Question', role: 'user', id: 'one' }])).revision, 1);
  await assert.rejects(session.append([{ id: 'one', role: 'user', text: 'Changed' }]), /different content/u);
  await assert.rejects(session.append([{ id: 'one', role: 'user', text: 'Question' }, { id: 'two', role: 'assistant', text: 'New' }]), /partial batch/u);
});

test('parallel tool results require exact pairing and are never executed during restore', async () => {
  const store = new MemoryStore(), session = await open({ store });
  await session.append([{ id: 'u', role: 'user', text: 'Work' }, { id: 'a', role: 'assistant', text: '', toolCalls: [
    { id: 'c1', name: 'one', arguments: {} }, { id: 'c2', name: 'two', arguments: {} },
  ] }]);
  await assert.rejects(session.prepare(options()), (error) => error.code === 'PENDING_TOOLS');
  await assert.rejects(session.append([{ role: 'tool', callId: 'c1', name: 'wrong', text: 'fake', isError: false }]), /outstanding call/u);
  const events = [];
  const restored = await open({ store, onEvent: (event) => events.push(event) });
  assert.deepEqual(events[0].pendingCallIds, ['c1', 'c2']);
  await restored.append([{ role: 'tool', callId: 'c2', name: 'two', text: 'actual error', isError: true }]);
  await restored.append([{ role: 'tool', callId: 'c1', name: 'one', text: 'actual result', isError: false }]);
  const context = await restored.prepare(options({ model: model(5000) }));
  assert.deepEqual(context.messages.slice(-2).map((message) => message.callId), ['c2', 'c1']);
  await assert.rejects(restored.append([{ role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'one', arguments: {} }] }]), /reused/u);
});

test('concurrent writers use revision comparison and never silently overwrite', async () => {
  const store = new MemoryStore();
  const one = await open({ store }), two = await open({ store });
  const results = await Promise.allSettled([
    one.append([{ id: 'one', role: 'user', text: 'One' }]), two.append([{ id: 'two', role: 'user', text: 'Two' }]),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await one.inspect()).messageCount, 1);
});

test('model window, instructions, tools, materials and output reserve all participate in budgeting', async () => {
  const session = await open();
  await session.append([{ role: 'user', text: 'Current' }]);
  const request = options({ model: model(64000), systemPrompt: 'Instructions', tools: [{ name: 'read' }], materials: [{ id: 'material', text: 'Reference' }], outputReserveTokens: 3000, safetyMarginTokens: 500 });
  const context = await session.prepare(request);
  assert.equal(context.budget.contextWindow, 64000);
  assert.equal(context.budget.inputTokens, tokenCount(context));
  assert.equal(context.budget.remainingTokens, 64000 - 3000 - 500 - context.budget.inputTokens);
  assert.equal(context.messages[0].synthetic, 'material');
  await assert.rejects(session.prepare({ ...request, model: model(50) }), ContextBudgetError);
});

test('usage calibration is scoped to model, fixed context and retained prefix', async () => {
  const session = await open();
  const smallCounter = { ...model(1000), countTokens: () => 50 };
  await session.append([{ id: 'u', role: 'user', text: 'Question' }]);
  const first = await session.prepare(options({ model: smallCounter }));
  await session.append([{ role: 'assistant', text: 'Reply' }], { expectedRevision: first.revision, usage: { basis: first.usageBasis, inputTokens: 140, outputTokens: 10 } });
  await session.append([{ role: 'user', text: 'Continue' }]);
  assert.equal((await session.prepare(options({ model: smallCounter }))).budget.inputTokens, 140);
  assert.equal((await session.prepare(options({ model: { ...smallCounter, id: 'other-provider/model' } }))).budget.usageAdjustmentTokens, 0);
  assert.equal((await session.prepare(options({ model: smallCounter, systemPrompt: 'Changed' }))).budget.usageAdjustmentTokens, 0);
  await assert.rejects(session.append([{ role: 'assistant', text: 'Stale' }], { expectedRevision: first.revision }), (error) => error.code === 'REVISION_CONFLICT');
});

test('compaction preserves raw history, the latest user input and a readable handoff', async () => {
  const store = new MemoryStore(), events = [];
  const session = await open({ store, summarizer: summarizer(), onEvent: (event) => events.push(event) });
  await history(session);
  const before = (await store.load(session.sessionId)).messages;
  const context = await session.prepare(options());
  assert.ok(context.checkpointId);
  assert.equal(context.messages[0].role, 'user');
  assert.match(context.messages[0].text, /untrusted historical/u);
  assert.ok(context.messages.some((message) => message.id === 'm-u5'));
  assert.ok(context.budget.remainingTokens >= 0);
  const after = await store.load(session.sessionId);
  assert.deepEqual(after.messages, before);
  const reference = after.checkpoints[0].handoff.goals[0].refs[0];
  assert.equal((await session.read(reference))[0].id, 'm-u0');
  assert.ok(events.some((event) => event.type === 'compaction-committed'));
});

test('incremental compaction merges the old handoff and only newly covered raw messages', async () => {
  const calls = [], store = new MemoryStore();
  const session = await open({ store, summarizer: summarizer(async (request) => { calls.push(request); return summary(request); }) });
  await history(session);
  await session.prepare(options());
  const first = (await session.inspect()).checkpoint;
  await history(session, 5, 260, 'next');
  await session.prepare(options());
  const second = (await session.inspect()).checkpoint;
  assert.equal(second.previousId, first.id);
  assert.ok(second.throughSequence > first.throughSequence);
  assert.ok(calls.at(-1).previous);
  assert.equal(calls.at(-1).messages[0].sequence, first.throughSequence + 1);
});

test('one long tool turn retains its initiating user and complete recent tool groups', async () => {
  const session = await open({ summarizer: summarizer() });
  await session.append([{ id: 'pinned', role: 'user', text: 'Keep this exact request' }]);
  for (let index = 0; index < 10; index++) await session.append([
    { role: 'assistant', text: '', toolCalls: [{ id: `call-${index}`, name: 'read', arguments: { index } }] },
    { role: 'tool', callId: `call-${index}`, name: 'read', text: 'r'.repeat(500), isError: false },
  ]);
  const context = await session.prepare(options());
  assert.ok(context.messages.some((message) => message.id === 'pinned'));
  for (const message of context.messages.filter((item) => item.role === 'tool')) {
    assert.ok(context.messages.some((item) => item.role === 'assistant' && item.toolCalls?.some((call) => call.id === message.callId)));
  }
});

test('malformed, incomplete or out-of-range summary never replaces a valid checkpoint', async () => {
  const bad = [
    (value) => ({ ...value, complete: false }),
    (value) => ({ ...value, throughId: 'invented' }),
    (value) => ({ ...value, handoff: { ...value.handoff, goals: [] } }),
    (value) => { value.handoff.goals[0].refs[0].endId = 'invented'; return value; },
    (value) => { value.handoff.goals[0].refs[0].sessionId = 'other'; return value; },
    (value) => { delete value.handoff.corrections; return value; },
  ];
  for (const corrupt of bad) {
    let fail = false;
    const session = await open({ summarizer: summarizer(async (request) => fail ? corrupt(summary(request)) : summary(request)) });
    await history(session); await session.prepare(options());
    const previous = (await session.inspect()).checkpoint;
    await history(session, 5, 260, 'new'); fail = true;
    await assert.rejects(session.prepare(options()));
    assert.deepEqual((await session.inspect()).checkpoint, previous);
  }
});

test('failure or cancellation during model generation retains the previous state', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const session = await open({ summarizer: summarizer(async (request) => {
      if (cancel) { controller.abort(); return summary(request); }
      throw new Error('model failed');
    }) });
    await history(session);
    const before = await session.inspect();
    await assert.rejects(session.prepare(options({ signal: controller.signal })));
    assert.deepEqual(await session.inspect(), before);
  }
});

test('new raw messages during compression cause a revision conflict, not lost history', async () => {
  let session;
  session = await open({ summarizer: summarizer(async (request) => {
    await session.append([{ id: 'arrived', role: 'user', text: 'New instruction' }]);
    return summary(request);
  }) });
  await history(session);
  await assert.rejects(session.prepare(options()), (error) => error.code === 'REVISION_CONFLICT');
  assert.equal((await session.inspect()).checkpoint, null);
  assert.equal((await session.read({ sessionId: session.sessionId, startId: 'arrived', endId: 'arrived' }))[0].text, 'New instruction');
});

test('cancellation is checked again at the store publication point', async () => {
  const controller = new AbortController();
  class CancelStore extends MemoryStore {
    async commit(id, revision, mutation, signal) {
      if (mutation.checkpoint) controller.abort();
      return super.commit(id, revision, mutation, signal);
    }
  }
  const session = await open({ store: new CancelStore(), summarizer: summarizer() });
  await history(session);
  await assert.rejects(session.prepare(options({ signal: controller.signal })), /abort/u);
  assert.equal((await session.inspect()).checkpoint, null);
});

test('oversized current input and a too-small summary model fail without raw truncation', async () => {
  const session = await open({ summarizer: summarizer() });
  await session.append([{ role: 'user', text: 'x'.repeat(20000) }]);
  await assert.rejects(session.prepare(options()), ContextBudgetError);
  assert.equal((await session.inspect()).messageCount, 1);
  const other = await open({ summarizer: { ...summarizer(), model: model(300), outputReserveTokens: 100 } });
  await history(other);
  await assert.rejects(other.prepare(options()), /complete protocol group/u);
  assert.equal((await other.inspect()).checkpoint, null);
});

test('bounded summary chunks are merged before a single checkpoint commit', async () => {
  const calls = [];
  const summaryModel = model(1800, 'small-summary');
  const session = await open({ summarizer: {
    model: summaryModel, outputReserveTokens: 400,
    summarize: async (request) => { calls.push(request); return summary(request); },
  } });
  await history(session, 18);
  await session.prepare(options());
  assert.ok(calls.length > 1);
  for (const request of calls) assert.ok(tokenCount(request.input) + 400 + 54 <= 1800);
  assert.equal((await session.inspect()).revision, 19);
});

test('JSON summary adapter rejects truncation and malformed output', async () => {
  for (const response of [{ complete: false, text: '{}' }, { complete: true, text: '```json\n{}\n```' }]) {
    const adapter = createJsonSummarizer({ model: model(20000), outputReserveTokens: 2000, generate: async () => response });
    const session = await open({ summarizer: adapter });
    await history(session);
    await assert.rejects(session.prepare(options()));
    assert.equal((await session.inspect()).checkpoint, null);
  }
});

test('observer exceptions do not make committed records appear to fail', async () => {
  const session = await open({ summarizer: summarizer(), onEvent: () => { throw new Error('UI observer failed'); } });
  await history(session);
  assert.ok((await session.prepare(options())).checkpointId);
});

test('switching to a smaller model can rewrite the same covered range without vendor state', async () => {
  const requests = [];
  const session = await open({ summarizer: summarizer(async (request) => {
    requests.push(request);
    const result = summary(request);
    if (request.messages.length) result.handoff.goals[0].text = 'verbose '.repeat(140);
    return result;
  }) });
  await history(session, 10, 500);
  await session.prepare(options({ model: model(2000, 'large') }));
  const before = (await session.inspect()).checkpoint;
  const context = await session.prepare(options({ model: model(600, 'small') }));
  const after = (await session.inspect()).checkpoint;
  assert.equal(context.modelId, 'small');
  assert.ok(context.budget.remainingTokens >= 0);
  assert.equal(after.throughSequence, before.throughSequence);
  assert.equal(after.previousId, before.id);
  assert.equal(requests.at(-1).messages.length, 0);
});

test('a failed later summary chunk commits no partial checkpoint', async () => {
  let calls = 0;
  const session = await open({ summarizer: {
    model: model(1800), outputReserveTokens: 400,
    summarize: async (request) => { if (++calls === 2) throw new Error('second chunk failed'); return summary(request); },
  } });
  await history(session, 18);
  await assert.rejects(session.prepare(options()), /second chunk failed/u);
  assert.equal((await session.inspect()).checkpoint, null);
  assert.equal((await session.inspect()).revision, 18);
});

test('a valid but target-oversized handoff does not publish a checkpoint', async () => {
  const session = await open({ summarizer: summarizer(async (request) => {
    const result = summary(request); result.handoff.goals[0].text = 's'.repeat(4000); return result;
  }) });
  await history(session);
  await assert.rejects(session.prepare(options()), /target model budget/u);
  assert.equal((await session.inspect()).checkpoint, null);
});

test('messages arriving during ordinary token counting invalidate the prepared revision', async () => {
  const session = await open();
  await session.append([{ role: 'user', text: 'Initial' }]);
  let once = false;
  const profile = { ...model(), countTokens: async () => {
    if (!once) { once = true; await session.append([{ role: 'user', text: 'Concurrent' }]); }
    return 1;
  } };
  await assert.rejects(session.prepare(options({ model: profile })), (error) => error.code === 'REVISION_CONFLICT');
});

test('inputs larger than 16K are accepted when the target model actually has room', async () => {
  const session = await open();
  await session.append([{ role: 'user', text: 'x'.repeat(80000) }]);
  const large = await session.prepare(options({ model: model(64000) }));
  assert.ok(large.budget.inputTokens > 16000);
  await assert.rejects(session.prepare(options({ model: model(16000) })), ContextBudgetError);
});
