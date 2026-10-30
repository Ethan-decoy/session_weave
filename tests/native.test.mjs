import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryStore, SessionWeave } from '../dist/index.js';
import { FileStore } from '../dist/file-store.js';
import { createOpenAINativeAdapter, createAnthropicNativeAdapter, confirmedNativeCapability, resolveAnthropicNativeCapability } from '../dist/native-adapters.js';
import { toPiContext } from '../dist/pi.js';

const backend = (extra = {}) => ({ provider: 'selected-provider', endpoint: 'https://selected.example/v1', model: 'selected-model', apiVersion: '2026-10-21', scope: 'selected-account', ...extra });
const marker = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-ciphertext-MUST-roundtrip', extension: { preserved: true } };
const textOutput = (text = 'Actual public reply') => ({ type: 'message', role: 'assistant', id: 'message_fixture', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const response = (id = 'resp_fixture', output = [textOutput()]) => ({ id, status: 'completed', output, usage: { input_tokens: 90, output_tokens: 12 } });
const signed = { type: 'compaction', content: 'Provider summary text', signature: 'exact-signature-\n+opaque/==' };
const anthResponse = (id = 'msg_fixture', content = [{ type: 'text', text: 'Actual reply' }], stop_reason = 'end_turn') => ({ id, role: 'assistant', model: 'selected-model', content, stop_reason, usage: { input_tokens: 90, output_tokens: 12 } });
function oa(extra = {}) {
  return createOpenAINativeAdapter({ backend: backend(), mode: 'server-threshold', thresholdTokens: 500,
    countTokens: () => 20, generate: async () => response(), ...extra });
}
function profile(adapter, extra = {}) {
  return { id: 'chosen-model/native-count-v1', contextWindow: 2000, maxOutputTokens: 500,
    countTokens: () => { throw new Error('Portable counter must not receive native state'); },
    backend: structuredClone(adapter.binding), nativeCompaction: confirmedNativeCapability(adapter, 'Exact deployment fixture verified'), ...extra };
}
const requestOptions = (adapter, extra = {}) => ({ model: profile(adapter), outputReserveTokens: 100, ...extra });
async function open(extra = {}) {
  const session = await SessionWeave.open({ sessionId: 'native-session', store: new MemoryStore(), ...extra });
  await session.append([{ id: 'original-user', role: 'user', text: 'Original user input' }]);
  return session;
}
const neverSummarize = { model: { id: 'generic', contextWindow: 10000, countTokens: () => 1 }, outputReserveTokens: 100,
  summarize: async () => { throw new Error('Generic summary was incorrectly invoked'); } };

test('auto prefers confirmed native support and refuses unknown or mismatched deployment evidence', async () => {
  const adapter = oa(), session = await open({ summarizer: neverSummarize });
  const context = await session.prepare(requestOptions(adapter));
  assert.equal(context.strategy, 'native');
  assert.equal(context.request.body.context_management[0].compact_threshold, 500);
  assert.equal((await session.inspect()).checkpoint, null);
  await assert.rejects(session.prepare({ model: { id: 'OpenAI-compatible-brand', contextWindow: 2000, countTokens: () => 1 }, outputReserveTokens: 100 }), (error) => error.code === 'CAPABILITY_UNKNOWN');
  for (const field of ['provider', 'endpoint', 'model', 'apiVersion', 'scope']) {
    const actual = { ...adapter.binding, [field]: field === 'endpoint' ? 'https://other.example/v1' : 'different' };
    await assert.rejects(session.prepare(requestOptions(adapter, { model: profile(adapter, { backend: actual }) })), (error) => error.code === 'NATIVE_BINDING_MISMATCH');
  }
});

test('confirmed unsupported chooses portable, while explicit native fails and explicit portable remains available', async () => {
  const adapter = oa(); let summaries = 0;
  const summarizer = { ...neverSummarize, summarize: async (request) => {
    summaries++;
    return { complete: true, throughId: request.throughId, handoff: { version: 1,
      goals: [{ text: 'Continue', refs: [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.throughId }] }],
      constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [],
    } };
  } };
  const session = await open({ summarizer });
  await session.append([{ role: 'assistant', text: 'Reply' }, { role: 'user', text: 'Next' }, { role: 'assistant', text: 'Reply two' }]);
  const generic = profile(adapter, { contextWindow: 150, countTokens: () => 20,
    nativeCompaction: { status: 'unsupported', binding: adapter.binding, evidence: 'Selected endpoint explicitly has no native feature' } });
  const context = await session.prepare({ model: generic, outputReserveTokens: 10, compactAt: 0.1 });
  assert.equal(context.strategy, 'portable'); assert.equal(summaries, 1);
  await assert.rejects(session.prepare({ model: generic, strategy: 'native', outputReserveTokens: 10 }), (error) => error.code === 'UNSUPPORTED_STRATEGY');
  const explicit = await session.prepare({ model: { ...generic, nativeCompaction: confirmedNativeCapability(adapter, 'Available but explicitly not selected') }, strategy: 'portable', outputReserveTokens: 10 });
  assert.equal(explicit.strategy, 'portable');
});

test('selected native runtime delegates without building API context or compacting twice', async () => {
  const session = await open({ summarizer: neverSummarize });
  const plan = await session.prepare({ runtime: { id: 'selected-agent', sessionId: 'explicit-native-thread', capabilities: { persistentSessions: true, compaction: true }, evidence: 'Verified selected runtime' } });
  assert.deepEqual(plan.delegate, { id: 'selected-agent', sessionId: 'explicit-native-thread' });
  assert.equal(plan.strategy, 'runtime');
  assert.equal('messages' in plan, false);
  await assert.rejects(session.prepare({ runtime: { id: 'agent', sessionId: '' } }));
  await assert.rejects(session.prepare({ runtime: { id: 'unverified-agent', sessionId: 'thread', capabilities: { persistentSessions: true, compaction: false }, evidence: 'No compaction' } }), (error) => error.code === 'UNSUPPORTED_STRATEGY');
});

test('OpenAI standalone preserves the entire canonical window, then commits full output and raw public text atomically', async () => {
  const canonical = [{ role: 'user', content: 'retained original' }, marker, { type: 'reasoning', encrypted_content: 'separate-reasoning', summary: [] }];
  let compactRequest, compactCalls = 0;
  const adapter = oa({ mode: 'on-demand', countTokens: (req) => req.body.input.some((item) => item.type === 'compaction') ? 20 : 850,
    compact: async (req) => { compactCalls++; compactRequest = req; return { id: 'compact_fixture', object: 'response.compaction', output: canonical, usage: { input_tokens: 850, output_tokens: 120 } }; },
    generate: async () => response('response_native', [{ type: 'reasoning', encrypted_content: 'private-reasoning' }, textOutput()]),
  });
  const store = new MemoryStore(), session = await open({ store, summarizer: neverSummarize });
  const context = await session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }), tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], systemPrompt: 'Selected instructions' }));
  assert.equal(compactCalls, 1);
  assert.deepEqual(Object.keys(compactRequest.body).sort(), ['input', 'instructions', 'model']);
  assert.deepEqual(context.request.body.input, canonical);
  assert.equal(context.request.body.store, false);
  const originalResponse = await adapter.send(context.request);
  const receipt = await session.accept(context, originalResponse);
  const artifact = await session.read({ sessionId: session.sessionId, nativeCheckpointId: receipt.nativeCheckpointId });
  assert.deepEqual(artifact.response, originalResponse);
  assert.deepEqual(artifact.state.input, [...canonical, ...originalResponse.output]);
  assert.equal((await store.load(session.sessionId)).checkpoints.length, 0);
  assert.equal((await session.read({ sessionId: session.sessionId, startId: 'original-user', endId: 'original-user' }))[0].text, 'Original user input');
  await session.append([{ id: 'next-user', role: 'user', text: 'Continue now' }]);
  const next = await session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }), tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], systemPrompt: 'Selected instructions' }));
  assert.equal(next.origin, 'resumed');
  assert.deepEqual(next.request.body.input, [...canonical, ...originalResponse.output, { role: 'user', content: 'Continue now' }]);
});

test('OpenAI previous_response_id sends only new inputs and persists the response identifier', async () => {
  assert.throws(() => oa({ continuation: 'previous-response-id' }), /server-storage/u);
  const adapter = oa({ continuation: 'previous-response-id', allowServerStorage: true, generate: async () => response('response_chain', [marker, textOutput()]) });
  const store = new MemoryStore(), session = await open({ store });
  const first = await session.prepare(requestOptions(adapter));
  assert.equal(first.request.body.store, true);
  const receipt = await session.accept(first, await adapter.send(first.request));
  const native = await session.read({ sessionId: session.sessionId, nativeCheckpointId: receipt.nativeCheckpointId });
  assert.deepEqual(native.state, { previous_response_id: 'response_chain' });
  await session.append([{ role: 'user', text: 'New delta only' }]);
  const next = await session.prepare(requestOptions(adapter));
  assert.equal(next.request.body.previous_response_id, 'response_chain');
  assert.deepEqual(next.request.body.input, [{ role: 'user', content: 'New delta only' }]);
  assert.equal(next.request.body.context_management[0].type, 'compaction');
});

test('native failures are propagated and never relabeled unsupported or sent to portable summarization', async () => {
  for (const status of [401, 429, 529]) {
    let fail = false;
    const expected = Object.assign(new Error('real provider failure'), { status, type: status === 529 ? 'compaction_unavailable' : 'transport_error' });
    const adapter = oa({ mode: 'on-demand', countTokens: () => fail ? 850 : 20, compact: async () => { throw expected; } });
    const session = await open({ summarizer: neverSummarize });
    const first = await session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }) }));
    await session.accept(first, response('prior_valid'));
    fail = true;
    const before = await session.inspect();
    await assert.rejects(session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }) })), (error) => error === expected);
    assert.deepEqual(await session.inspect(), before);
    assert.equal(adapter.binding.model, 'selected-model');
  }
});

test('provider generation errors leave the checkpoint unchanged, without any client-summary retry', async () => {
  const expected = new Error('generation timeout');
  const adapter = oa({ generate: async () => { throw expected; } });
  const session = await open({ summarizer: neverSummarize });
  const context = await session.prepare(requestOptions(adapter));
  const before = await session.inspect();
  await assert.rejects(adapter.send(context.request), (error) => error === expected);
  assert.deepEqual(await session.inspect(), before);
});

test('cancellation, malformed compact output and target overflow do not commit a native checkpoint', async () => {
  for (const kind of ['cancel', 'missing-marker', 'oversized']) {
    const abort = new AbortController();
    const adapter = oa({ mode: 'on-demand', countTokens: (req) => req.body.input.some((item) => item.type === 'compaction') ? kind === 'oversized' ? 950 : 20 : 850,
      compact: async () => { if (kind === 'cancel') abort.abort(); return { id: 'c', object: 'response.compaction', output: kind === 'missing-marker' ? [textOutput()] : [marker] }; },
    });
    const session = await open(), before = await session.inspect();
    await assert.rejects(session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }), signal: abort.signal })));
    assert.deepEqual(await session.inspect(), before);
  }
});

test('new messages during native compaction cause a revision conflict and remain in the raw log', async () => {
  let session;
  const adapter = oa({ mode: 'on-demand', countTokens: () => 850,
    compact: async () => { await session.append([{ id: 'arrived', role: 'user', text: 'New input' }]); return { id: 'c', object: 'response.compaction', output: [marker] }; },
  });
  session = await open();
  await assert.rejects(session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }) })), (error) => error.code === 'REVISION_CONFLICT');
  assert.equal((await session.inspect()).messageCount, 2);
  assert.equal((await session.inspect()).nativeCheckpoint, null);
});

test('native responses are revision checked, immutable at call time and safely idempotent', async () => {
  const adapter = oa(), session = await open();
  const context = await session.prepare(requestOptions(adapter));
  const original = response('unique-response');
  const pending = session.accept(context, original);
  original.output[0].content[0].text = 'Mutated after accept was called';
  const receipt = await pending;
  assert.equal((await session.read({ sessionId: session.sessionId, startId: receipt.messageIds[0], endId: receipt.messageIds[0] }))[0].text, 'Actual public reply');
  assert.equal((await session.accept(context, response('unique-response'))).replayed, true);
  await assert.rejects(session.accept(context, response('unique-response', [textOutput('Different')])));
  const next = await session.prepare(requestOptions(adapter));
  await assert.rejects(session.accept(next, response('unique-response')), (error) => error.code === 'NATIVE_RESPONSE_REPLAY');
  await session.append([{ role: 'user', text: 'Concurrent user input' }]);
  await assert.rejects(session.accept(next, response('new-response')), (error) => error.code === 'REVISION_CONFLICT');
});

test('native plans cannot be edited, reused in another open instance or passed through Pi', async () => {
  const adapter = oa(), store = new MemoryStore(), session = await open({ store });
  const context = await session.prepare(requestOptions(adapter));
  assert.throws(() => toPiContext(context, {}, []), /raw protocol/u);
  const other = await SessionWeave.open({ sessionId: session.sessionId, store });
  await assert.rejects(other.accept(context, response()), (error) => error.code === 'NATIVE_PLAN_INVALID');
  context.request.body.instructions = 'Changed after counting';
  await assert.rejects(session.accept(context, response()), /modified/u);
  assert.equal((await session.inspect()).nativeCheckpoint, null);
});

test('native tool requests/results remain paired and are never executed by resume', async () => {
  const adapter = oa(), store = new MemoryStore(), session = await open({ store });
  const context = await session.prepare(requestOptions(adapter));
  const wire = response('tool-response', [marker, { type: 'function_call', id: 'item-call', call_id: 'actual-call', name: 'read', arguments: '{"path":"fixture"}' }]);
  await session.accept(context, wire);
  const restored = await SessionWeave.open({ sessionId: session.sessionId, store });
  assert.deepEqual((await restored.inspect()).pendingCallIds, ['actual-call']);
  await assert.rejects(restored.prepare(requestOptions(adapter)), (error) => error.code === 'PENDING_TOOLS');
  await restored.append([{ role: 'tool', callId: 'actual-call', name: 'read', text: 'Stored real result', isError: false }]);
  const next = await restored.prepare(requestOptions(adapter));
  assert.deepEqual(next.request.body.input.slice(0, -1), [...context.request.body.input, ...wire.output]);
  assert.deepEqual(next.request.body.input.at(-1), { type: 'function_call_output', call_id: 'actual-call', output: 'Stored real result' });
});

test('switching deployment bindings rebuilds from original records and never forwards old opaque state', async () => {
  const session = await open(), first = oa();
  const initial = await session.prepare(requestOptions(first));
  await session.accept(initial, response('opaque-state', [marker, textOutput()]));
  await session.append([{ role: 'user', text: 'New target' }]);
  const target = oa({ backend: backend({ model: 'other-selected-model' }) });
  const rebuilt = await session.prepare(requestOptions(target));
  assert.equal(rebuilt.origin, 'rebuilt');
  assert.equal(rebuilt.rebuildReason, 'backend-binding-changed');
  assert.equal(JSON.stringify(rebuilt.request).includes(marker.encrypted_content), false);
  assert.equal(rebuilt.request.body.model, 'other-selected-model');
  const generic = await session.prepare({ model: { id: 'portable-target', contextWindow: 5000, countTokens: () => 1 }, outputReserveTokens: 100, strategy: 'portable' });
  assert.equal(generic.origin, 'rebuilt');
  assert.equal(JSON.stringify(generic.messages).includes(marker.encrypted_content), false);
  const before = await session.inspect();
  const tooSmall = oa({ mode: 'on-demand', backend: backend({ model: 'too-small' }), countTokens: () => 3000, compact: async () => { throw Error('Must not send oversized native input'); } });
  await assert.rejects(session.prepare(requestOptions(tooSmall)), /too large/u);
  assert.deepEqual(await session.inspect(), before);
});

test('unknown nonportable public blocks remain archived and block lossy cross-model migration', async () => {
  const adapter = oa(), session = await open();
  const context = await session.prepare(requestOptions(adapter));
  const wire = response('rich-output', [{ type: 'provider_public_extension', body: { exact: 'raw-data' } }, textOutput()]);
  const receipt = await session.accept(context, wire);
  assert.deepEqual((await session.read({ sessionId: session.sessionId, nativeCheckpointId: receipt.nativeCheckpointId })).response, wire);
  await assert.rejects(session.prepare({ model: { id: 'generic', contextWindow: 5000, countTokens: () => 1 }, outputReserveTokens: 100, strategy: 'portable' }), (error) => error.code === 'NATIVE_MATERIALIZATION_REQUIRED');
});

test('storage must opt in to the atomic native-state contract before any provider operation', async () => {
  const memory = new MemoryStore();
  const store = { load: memory.load.bind(memory), commit: memory.commit.bind(memory) };
  const session = await open({ store });
  await assert.rejects(session.prepare(requestOptions(oa())), (error) => error.code === 'NATIVE_STORAGE_UNSUPPORTED');
});

test('cancellation at native response publication preserves raw log and prior continuation together', async () => {
  const controller = new AbortController();
  class CancelStore extends MemoryStore {
    async commit(id, revision, mutation, signal) {
      if (mutation.nativeCheckpoint) controller.abort();
      return super.commit(id, revision, mutation, signal);
    }
  }
  const session = await open({ store: new CancelStore() }), adapter = oa();
  const context = await session.prepare(requestOptions(adapter));
  const before = await session.inspect();
  await assert.rejects(session.accept(context, response(), { signal: controller.signal }), /abort/u);
  assert.deepEqual(await session.inspect(), before);
});

test('native counting cannot publish a context after concurrent input arrives', async () => {
  let session, once = false;
  const adapter = oa({ countTokens: async () => {
    if (!once) { once = true; await session.append([{ role: 'user', text: 'Arrived during count' }]); }
    return 20;
  } });
  session = await open();
  await assert.rejects(session.prepare(requestOptions(adapter)), (error) => error.code === 'REVISION_CONFLICT');
  assert.equal((await session.inspect()).messageCount, 2);
});

test('native policy rebuilds full raw history rather than feeding an earlier Handoff to the provider', async () => {
  const adapter = oa(), session = await open({ summarizer: { ...neverSummarize, summarize: async (request) => ({ complete: true, throughId: request.throughId, handoff: {
    version: 1, goals: [{ text: 'NOT-A-NATIVE-WINDOW', refs: [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.throughId }] }],
    constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [],
  } }) } });
  await session.append([{ role: 'assistant', text: 'Earlier reply' }, { role: 'user', text: 'Earlier next' }, { role: 'assistant', text: 'Earlier reply two' }]);
  await session.prepare({ model: { id: 'portable', contextWindow: 150, countTokens: () => 20 }, outputReserveTokens: 10, compactAt: 0.1, strategy: 'portable' });
  const context = await session.prepare(requestOptions(adapter));
  assert.equal(context.origin, 'rebuilt');
  assert.equal(context.rebuildReason, 'portable-to-native');
  assert.equal(context.request.body.input.length, 4);
  assert.equal(JSON.stringify(context.request).includes('NOT-A-NATIVE-WINDOW'), false);
});

test('appends capture the original message before asynchronous storage reads', async () => {
  const session = await open();
  const input = { id: 'captured', role: 'user', text: 'Before mutation' };
  const pending = session.append([input]);
  input.text = 'After mutation';
  await pending;
  assert.equal((await session.read({ sessionId: session.sessionId, startId: input.id, endId: input.id }))[0].text, 'Before mutation');
});

test('returning to portable rebuilds raw input and summaries while retaining the audit checkpoint chain', async () => {
  const requests = [];
  const store = new MemoryStore();
  const session = await open({ store, summarizer: { ...neverSummarize, summarize: async (request) => {
    requests.push(request);
    return { complete: true, throughId: request.throughId, handoff: {
      version: 1, goals: [{ text: `summary-${requests.length}`, refs: [{ sessionId: request.sessionId, startId: request.messages[0].id, endId: request.throughId }] }],
      constraints: [], decisions: [], completed: [], openQuestions: [], corrections: [],
    } };
  } } });
  await session.append([{ role: 'assistant', text: 'Old answer' }, { role: 'user', text: 'Another question' }, { role: 'assistant', text: 'Another answer' }]);
  const portableOptions = { strategy: 'portable', model: { id: 'portable', contextWindow: 150, countTokens: () => 20 }, outputReserveTokens: 10, compactAt: 0.1 };
  const old = await session.prepare(portableOptions);
  assert.ok(old.checkpointId);
  const adapter = oa();
  const native = await session.prepare(requestOptions(adapter));
  await session.accept(native, response('native-after-portable'));
  const raw = await session.prepare({ ...portableOptions, model: { id: 'portable-large', contextWindow: 5000, countTokens: () => 1 }, outputReserveTokens: 100 });
  assert.equal(raw.origin, 'rebuilt');
  assert.equal(raw.checkpointId, null);
  assert.equal(raw.messages.some((message) => message.synthetic === 'handoff'), false);
  assert.deepEqual(raw.messages.map((message) => message.id), (await store.load(session.sessionId)).messages.map((message) => message.id));
  const rebuilt = await session.prepare(portableOptions);
  assert.equal(rebuilt.origin, 'rebuilt');
  assert.equal(requests.at(-1).previous, null);
  assert.equal(requests.at(-1).messages[0].id, 'original-user');
  const history = await store.load(session.sessionId);
  assert.equal(history.checkpoints.at(-1).previousId, old.checkpointId);
  assert.equal(history.nativeCheckpoints.length, 1);
});

test('Anthropic on-demand replaces the summarized window with exactly one original signed block', async () => {
  let compactRequest;
  const adapter = createAnthropicNativeAdapter({ backend: backend(), mode: 'on-demand',
    countTokens: (req) => req.body.messages[0]?.content?.[0]?.type === 'compaction' ? 20 : 850,
    compact: async (req) => { compactRequest = req; return anthResponse('compact-anth', [signed], 'compaction'); },
    generate: async () => anthResponse('message-anth', [{ type: 'thinking', thinking: 'provider internal', signature: 'reasoning-signature' }, { type: 'text', text: 'Actual reply' }]),
  });
  const session = await open({ summarizer: neverSummarize });
  const opts = requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }), systemPrompt: 'Current instructions', tools: [{ name: 'read', input_schema: { type: 'object' } }] });
  const context = await session.prepare(opts);
  assert.equal(compactRequest.body.compaction.type, 'summarize');
  assert.equal('context_management' in compactRequest.body, false);
  assert.equal(context.request.headers['anthropic-beta'], 'compact-2026-09-04');
  assert.deepEqual(context.request.body.messages, [{ role: 'assistant', content: [signed] }]);
  const wire = await adapter.send(context.request);
  const receipt = await session.accept(context, wire);
  await session.append([{ role: 'user', text: 'Continue' }]);
  const next = await session.prepare(opts);
  assert.deepEqual(next.request.body.messages[0], { role: 'assistant', content: [signed] });
  assert.deepEqual(next.request.body.messages[1], { role: 'assistant', content: wire.content });
  assert.deepEqual(Object.keys(next.request.body.messages[1]).sort(), ['content', 'role']);
  assert.deepEqual((await session.read({ sessionId: session.sessionId, nativeCheckpointId: receipt.nativeCheckpointId })).response, wire);
});

test('Anthropic threshold appends the whole assistant content and uses its distinct beta/edit contract', async () => {
  const content = [{ type: 'compaction', content: 'Threshold handoff' }, { type: 'thinking', thinking: 'internal', signature: 'signature' }, { type: 'text', text: 'Visible reply' }];
  const adapter = createAnthropicNativeAdapter({ backend: backend(), mode: 'server-threshold', thresholdTokens: 50000, pauseAfterCompaction: true,
    countTokens: () => 100, generate: async () => anthResponse('threshold-response', content),
  });
  const session = await open();
  const opts = requestOptions(adapter, { model: profile(adapter, { contextWindow: 100000 }) });
  const context = await session.prepare(opts);
  assert.equal(context.request.headers['anthropic-beta'], 'compact-2026-01-12');
  assert.equal(context.request.body.context_management.edits[0].type, 'compact_20260112');
  assert.equal(context.request.body.context_management.edits[0].trigger.value, 50000);
  assert.equal('compaction' in context.request.body, false);
  await session.accept(context, await adapter.send(context.request));
  const next = await session.prepare(opts);
  assert.deepEqual(next.request.body.messages, [...context.request.body.messages, { role: 'assistant', content }]);
});

test('Anthropic incomplete/signatureless/null compaction results keep the previous checkpoint', async () => {
  for (const wire of [anthResponse('empty', [], 'end_turn'), anthResponse('truncated', [signed], 'max_tokens'), anthResponse('unsigned', [{ type: 'compaction', content: 'Text' }], 'compaction'), anthResponse('null', [{ ...signed, content: null }], 'compaction'), anthResponse('extra-null', [{ ...signed, citations: null }], 'compaction')]) {
    const adapter = createAnthropicNativeAdapter({ backend: backend(), mode: 'on-demand', countTokens: () => 850, generate: async () => wire });
    const session = await open(), before = await session.inspect();
    await assert.rejects(session.prepare(requestOptions(adapter, { model: profile(adapter, { contextWindow: 1000 }) })));
    assert.deepEqual(await session.inspect(), before);
  }
});

test('Anthropic Models capability objects distinguish confirmed support, unsupported and unknown', () => {
  const adapter = createAnthropicNativeAdapter({ backend: backend(), mode: 'on-demand', generate: async () => {}, countTokens: () => 1 });
  const resolve = (compaction) => resolveAnthropicNativeCapability(adapter, { id: adapter.binding.model, capabilities: { compaction } }).status;
  assert.equal(resolve(null), 'unknown');
  assert.equal(resolve({ supported: true }), 'unknown');
  assert.equal(resolve({ supported: true, summarize: { supported: true } }), 'supported');
  assert.equal(resolve({ supported: true, summarize: { supported: false } }), 'unsupported');
  const threshold = createAnthropicNativeAdapter({ backend: backend(), mode: 'server-threshold', thresholdTokens: 50000, generate: async () => {}, countTokens: () => 1 });
  assert.equal(resolveAnthropicNativeCapability(threshold, { id: threshold.binding.model, capabilities: { context_management: { supported: true, compact_20260112: { supported: true } } } }).status, 'supported');
});

test('FileStore restores native ciphertext in a separate process, preserves raw files and upgrades only the manifest', async (t) => {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, 'sw-native-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('sw-native-')); await rm(root, { recursive: true, force: true }); });
  const store = new FileStore(root), session = await open({ store });
  const folder = path.join(root, createHash('sha256').update(session.sessionId).digest('hex'));
  const rawFile = path.join(folder, 'raw/original-user.json'), original = await readFile(rawFile);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).version, 1);
  const adapter = oa();
  const context = await session.prepare(requestOptions(adapter));
  await session.accept(context, response('persisted', [marker, textOutput()]));
  assert.equal(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')).version, 2);
  assert.equal((await readdir(path.join(folder, 'native-checkpoints'))).length, 1);
  assert.deepEqual(await readFile(rawFile), original);
  const code = `import {SessionWeave} from ${JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)};
import {FileStore} from ${JSON.stringify(pathToFileURL(path.resolve('dist/file-store.js')).href)};
import {createOpenAINativeAdapter,confirmedNativeCapability} from ${JSON.stringify(pathToFileURL(path.resolve('dist/native-adapters.js')).href)};
const a=createOpenAINativeAdapter({backend:${JSON.stringify(backend())},mode:'server-threshold',thresholdTokens:500,countTokens:()=>20,generate:async()=>{throw Error('must not execute history')}});
const s=await SessionWeave.open({sessionId:'native-session',store:new FileStore(${JSON.stringify(root)})});
const c=await s.prepare({model:{id:'chosen-model/native-count-v1',contextWindow:2000,countTokens:()=>{throw Error('no portable')} ,backend:a.binding,nativeCompaction:confirmedNativeCapability(a,'fixture')},outputReserveTokens:100});
console.log(JSON.stringify({origin:c.origin,input:c.request.body.input,status:await s.inspect()}));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.equal(restored.origin, 'resumed');
  assert.deepEqual(restored.input, [...context.request.body.input, marker, textOutput()]);
  assert.deepEqual(restored.status.pendingCallIds, []);
});
