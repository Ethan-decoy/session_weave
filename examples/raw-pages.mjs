import assert from 'node:assert/strict';
import { SessionWeave, MemoryStore, estimateInputTokens } from '../dist/index.js';

// A core-only read tool example: no OM, model, provider or domain executor.
const session = await SessionWeave.open({ sessionId: 'raw-reader', store: new MemoryStore() });
await session.append([
  { id: 'question', role: 'user', text: 'Inspect the original evidence.' },
  { id: 'request', role: 'assistant', text: '', toolCalls: [{ id: 'recorded-operation', name: 'host_read', arguments: { path: '/source' } }] },
  { id: 'result', role: 'tool', callId: 'recorded-operation', name: 'host_read', text: 'Original evidence: 状态unknown 💡\n'.repeat(90), isError: false },
]);
const range = { sessionId: session.sessionId, startId: 'result', endId: 'result' };
const options = { maxTokens: 1800, countTokens: (page) => estimateInputTokens({ systemPrompt: '', tools: [], messages: [
  { id: 'current-read-result', sequence: 0, createdAt: '1970-01-01T00:00:00.000Z', role: 'tool', callId: 'current-read', name: 'read_raw_page', text: JSON.stringify(page), isError: false },
] }) };
const pages = [];
do {
  const page = await session.readPage(range, { ...options, ...(pages.length ? { cursor: pages.at(-1).nextCursor } : {}) });
  assert.ok(options.countTokens(page) <= options.maxTokens);
  pages.push(page);
} while (!pages.at(-1).done);
const record = JSON.parse(pages.map((page) => page.text).join(''));
assert.deepEqual(record, (await session.read(range))[0]);
console.log(JSON.stringify({ pages: pages.length, unit: pages[0].position.unit, format: pages[0].format,
  recoveredMessageId: record.id, recoveredTextLength: record.text.length, complete: pages.at(-1).done,
  pageBudget: options.maxTokens, largestEstimatedEnvelope: Math.max(...pages.map(options.countTokens)) }, null, 2));
// The host still budgets the complete actor request and decides when to call this reader.
