import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ModelCallContext } from './types.js';

const scope = new AsyncLocalStorage<ModelCallContext>();

/** Capture in a host model/transport wrapper, before awaiting or returning its stream. */
export function getModelCallContext(): ModelCallContext | undefined {
  return scope.getStore();
}

/** Internal scopes contain correlation metadata only; actual usage belongs to the host wrapper. */
export function withModelCall<T>(context: Omit<ModelCallContext, 'callId'>, run: () => T): T {
  return scope.run(Object.freeze({ ...context, callId: randomUUID() }), run);
}

export function withMemoryContext<T>(context: Omit<ModelCallContext, 'phase' | 'callId'>, run: () => T): T {
  return scope.run(Object.freeze({ ...context, phase: 'working-memory' }), run);
}
