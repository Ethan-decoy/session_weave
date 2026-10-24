import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionWeave, MemoryStore } from '../dist/index.js';
import { fromPiAssistant, toPiContext, piModelProfile, piUsage } from '../dist/pi.js';

const target = { id: 'target', provider: 'provider', api: 'openai-completions', contextWindow: 50000, maxTokens: 8000 };
const response = (extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text: 'Public answer' }, { type: 'thinking', thinking: 'Private nonportable reasoning' }], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }, ...extra });
test('Pi bridge carries public text/tools, real capacity and total cached input usage', async () => {
  const session = await SessionWeave.open({ sessionId: 'pi', store: new MemoryStore() });
  await session.append([{ id: 'u', role: 'user', text: 'Question' }]);
  const model = piModelProfile(target, () => 20);
  const context = await session.prepare({ model, outputReserveTokens: 1000 });
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
  const nextContext = await session.prepare({ model: piModelProfile(nextTarget, () => 20), outputReserveTokens: 1000 });
  const switched = toPiContext(nextContext, nextTarget, []);
  assert.equal(switched.messages.at(-1).provider, 'other-provider');
});
test('Pi bridge rejects interrupted, invalid-argument and unsupported public outputs', () => {
  for (const stopReason of ['length', 'error', 'aborted', 'pending', 'deferred']) assert.throws(() => fromPiAssistant(response({ stopReason })));
  assert.throws(() => fromPiAssistant(response({ content: [{ type: 'image', data: 'not silently lost' }] })));
  assert.throws(() => fromPiAssistant(response({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {}, argumentsError: 'incomplete JSON' }] })));
  assert.throws(() => fromPiAssistant(response({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'read', namespace: 'provider-only', arguments: {} }] })));
});
