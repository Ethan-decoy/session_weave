import { RevisionConflictError } from './errors.js';
import { emptyState, mutate } from './protocol.js';
import type { Mutation, SessionState, SessionStore } from './types.js';

export class MemoryStore implements SessionStore {
  private readonly states = new Map<string, SessionState>();
  async load(id: string): Promise<SessionState | null> { return structuredClone(this.states.get(id) ?? null); }
  async commit(id: string, revision: number, mutation: Mutation, signal?: AbortSignal): Promise<SessionState> {
    const state = this.states.get(id) ?? emptyState(id);
    if (state.revision !== revision) throw new RevisionConflictError();
    const next = mutate(state, mutation);
    signal?.throwIfAborted();
    this.states.set(id, next);
    return structuredClone(next);
  }
}
