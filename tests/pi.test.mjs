import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionWeave, MemoryStore } from '../dist/index.js';
import { fromPiAssistant, toPiContext, piModelProfile, piUsage } from '../dist/pi.js';
import { requestModelStep } from '../examples/qb-pi.mjs';

const target = { id: 'target', provider: 'provider', api: 'openai-completions', contextWindow: 50000, maxTokens: 8000 };
const response = (extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text: 'Public answer' }, { type: 'thinking', thinking: 'Private nonportable reasoning' }], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }, ...extra });
test('Pi bridge carries public text/tools, real capacity and total cached input usage', async () => {
  const session = await SessionWeave.open({ sessionId: 'pi', store: new MemoryStore() });
  await session.append([{ id: 'u', role: 'user', text: 'Question' }]);
  const model = piModelProfile(target, () => 20);
  const context = await session.prepare({ strategy: 'portable', model, outputReserveTokens: 1000 });
  assert.equal(context.budget.contextWindow, 50000);
  const input = toPiContext(context, target, []);
  assert.equal(input.messages[0].content, 'Question');
  const assistant = fromPiAssistant(response(), 'response');
  assert.equal(assistant.text, 'Public answer');
  assert.equal(JSON.stringify(assistant).includes('Private nonportable'), false);
  assert.equal(piUsage(context, response()).inputTokens, 33);
  await session.append([assistant], { expectedRevision: context.revision, usage: piUsage(context, response()) });
  const nextTarget = { ...target, id: 'new-model', provider: 'other-provider' };
  assert.throws(() => toPiContext(context, nextTarget, []), /new context/u);
  const nextContext = await session.prepare({ strategy: 'portable', model: piModelProfile(nextTarget, () => 20), outputReserveTokens: 1000 });
  const switched = toPiContext(nextContext, nextTarget, []);
  assert.equal(switched.messages.at(-1).provider, 'other-provider');
});
test('Pi bridge rejects interrupted, invalid-argument and unsupported public outputs', () => {
  for (const stopReason of ['length', 'error', 'aborted', 'pending', 'deferred']) assert.throws(() => fromPiAssistant(response({ stopReason })));
  assert.throws(() => fromPiAssistant(response({ content: [{ type: 'image', data: 'not silently lost' }] })));
  assert.throws(() => fromPiAssistant(response({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {}, argumentsError: 'incomplete JSON' }] })));
  assert.throws(() => fromPiAssistant(response({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'read', namespace: 'provider-only', arguments: {} }] })));
});

test('Pi example requires an explicit portable choice and then commits the completed response', async () => {
  const session = await SessionWeave.open({ sessionId: 'pi-example', store: new MemoryStore() });
  await session.append([{ id: 'u', role: 'user', text: 'Question' }]);
  const model = piModelProfile(target, () => 20);
  assert.equal(model.nativeCompaction.status, 'unknown');
  await assert.rejects(session.prepare({ model, outputReserveTokens: 1000 }), (error) => error.code === 'CAPABILITY_UNKNOWN');
  let calls = 0;
  const options = { model: target, outputReserveTokens: 1000, countTokens: () => 20, responseMessageId: 'pi-example-response',
    complete: async () => { calls++; return response(); } };
  await assert.rejects(requestModelStep(session, options), /explicit portable/u);
  assert.equal(calls, 0);
  const result = await requestModelStep(session, { ...options, strategy: 'portable' });
  assert.equal(result.context.strategy, 'portable');
  assert.equal(calls, 1);
  assert.deepEqual(result.receipt.messageIds, ['pi-example-response']);
  assert.equal((await session.inspect()).messageCount, 2);
});
