export class SessionWeaveError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SessionWeaveError'; }
}
export class RevisionConflictError extends SessionWeaveError {
  constructor() { super('REVISION_CONFLICT', 'Session changed; reload and retry from the new revision.'); }
}
export class ContextBudgetError extends SessionWeaveError {
  constructor(message: string) { super('CONTEXT_BUDGET', message); }
}
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SessionWeaveError('INVALID_STATE', message);
}
export const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
