import { ContextBudgetError, integer, invariant, SessionWeaveError } from './errors.js';
import { json, jsonDigest } from './data.js';
import type { Message, RawPage, ReadPageOptions, Reference } from './types.js';

const FORMAT = 'sessionweave-message-json@1';
const MAX_UNITS = 65_536;
type Cursor = { version: 1; digest: string; messageId: string; offset: number };
const cursorFor = (cursor: Cursor) => Buffer.from(json(cursor)).toString('base64url');
const invalidCursor = (): never => { throw new SessionWeaveError('INVALID_READ_CURSOR', 'Raw cursor is malformed, outside this record, or belongs to different range content.'); };
function parseCursor(encoded: string): Cursor {
  try {
    if (typeof encoded !== 'string' || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return invalidCursor();
    const cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Cursor;
    if (!cursor || Object.keys(cursor).length !== 4 || cursor.version !== 1 || typeof cursor.digest !== 'string'
      || typeof cursor.messageId !== 'string' || !integer(cursor.offset) || cursorFor(cursor) !== encoded) return invalidCursor();
    return cursor;
  } catch { return invalidCursor(); }
}
function splitsPair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Internal presentation over the existing immutable range read; no revision or model dependency. */
export async function presentRawPage(messages: Message[], range: Reference, options: ReadPageOptions): Promise<RawPage> {
  const { maxTokens, signal } = options;
  invariant(integer(maxTokens) && typeof options.countTokens === 'function', 'A nonnegative page budget and an envelope token counter are required.');
  signal?.throwIfAborted();
  invariant(messages.length > 0 && messages[0]!.id === range.startId && messages.at(-1)!.id === range.endId, 'Raw page needs the entire selected immutable range.');
  const digest = jsonDigest({ format: FORMAT, range, messages });
  const cursor = options.cursor === undefined ? undefined : parseCursor(options.cursor);
  const index = cursor ? messages.findIndex((message) => message.id === cursor.messageId) : 0;
  if (cursor && (cursor.digest !== digest || index < 0)) return invalidCursor();
  const message = messages[index]!;
  const text = json(message), start = cursor?.offset ?? 0;
  if (start >= text.length || splitsPair(text, start)) return invalidCursor();
  const minimum = start + (splitsPair(text, start + 1) ? 2 : 1);
  let maximum = Math.min(start + MAX_UNITS, text.length);
  if (splitsPair(text, maximum)) maximum--;
  function page(end: number): RawPage {
    const recordDone = end === text.length, done = recordDone && index === messages.length - 1;
    return { version: 1, range: structuredClone(range), rangeDigest: digest,
      source: { sessionId: range.sessionId, startId: message.id, endId: message.id }, sequence: message.sequence,
      format: FORMAT, position: { unit: 'utf16-code-unit', start, end, total: text.length }, text: text.slice(start, end), done,
      nextCursor: done ? null : cursorFor({ version: 1, digest,
        messageId: recordDone ? messages[index + 1]!.id : message.id, offset: recordDone ? 0 : end }) };
  }
  async function fits(candidate: RawPage): Promise<boolean> {
    signal?.throwIfAborted();
    const tokens = await options.countTokens(structuredClone(candidate));
    signal?.throwIfAborted();
    invariant(integer(tokens), 'Page counter must return a nonnegative safe integer.');
    return tokens <= maxTokens;
  }
  // Test the terminal page too: dropping its continuation cursor can make it smaller.
  const largest = page(maximum);
  if (await fits(largest)) return largest;
  const smallest = page(minimum);
  if (maximum === minimum || !await fits(smallest)) throw new ContextBudgetError('Even a minimal raw fragment and its full reference/continuation/tool envelope cannot fit the page budget.');
  let best = smallest, lower = minimum, upper = maximum;
  while (upper - lower > 1) {
    let middle = Math.floor((upper + lower) / 2);
    if (splitsPair(text, middle)) middle--;
    if (middle <= lower) break;
    const candidate = page(middle);
    if (await fits(candidate)) { best = candidate; lower = middle; }
    else upper = middle;
  }
  // Tokenizers need not be monotonic in prefix length. Return only an actually counted fit;
  // do not claim the largest possible page or count only its text body.
  return best;
}
