import { invariant } from './errors.js';

export function safeId(id: string): void {
  invariant(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id), 'IDs must contain 1–128 letters, digits, hyphens or underscores.');
}
export function json(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    invariant(item === null || ['string', 'boolean', 'number', 'object'].includes(typeof item), 'Values must be JSON data.');
    if (typeof item === 'number') invariant(Number.isFinite(item), 'JSON numbers must be finite.');
    if (item && typeof item === 'object') {
      invariant(!seen.has(item), 'Cyclic JSON is not supported.');
      invariant(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype, 'Only plain JSON data is supported.');
      seen.add(item);
      for (const child of Object.values(item)) visit(child);
      seen.delete(item);
    }
  };
  visit(value);
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}
