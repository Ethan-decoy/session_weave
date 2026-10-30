import { createHash } from 'node:crypto';
import { SessionWeaveError, invariant, integer } from './errors.js';
import { json } from './data.js';
import type { ModelProfile, PrepareOptions, SessionState } from './types.js';
import type { NativeAdapter, NativeBinding, NativeCapability, NativeCheckpoint, NativeRequest, JsonObject } from './native-types.js';

export const digest = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex');
export function nativeError(code: string, message: string): never { throw new SessionWeaveError(code, message); }
export function object(value: unknown, label = 'Native value'): JsonObject {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object.`);
  json(value);
  return value as JsonObject;
}
export function validateBinding(binding: NativeBinding): void {
  invariant(binding && ['provider', 'endpoint', 'model', 'apiVersion', 'scope', 'protocol', 'capability'].every((key) => typeof binding[key as keyof NativeBinding] === 'string' && binding[key as keyof NativeBinding].trim().length > 0), 'Complete native deployment identity is required.');
  invariant(Object.keys(binding).every((key) => ['provider', 'endpoint', 'model', 'apiVersion', 'scope', 'protocol', 'capability'].includes(key)), 'Native binding contains unknown fields.');
  const endpoint = new URL(binding.endpoint);
  invariant(['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Native endpoint must be a credential-free base URL; version and scope are separate fields.');
}
export const sameBinding = (one: NativeBinding, two: NativeBinding): boolean => digest(one) === digest(two);
export function confirmedNativeCapability(adapter: NativeAdapter, evidence: string): NativeCapability {
  validateBinding(adapter.binding);
  invariant(typeof evidence === 'string' && evidence.trim().length > 0, 'Record deployment-specific native capability evidence.');
  return { status: 'supported', binding: structuredClone(adapter.binding), evidence, adapter };
}
export function selectCompactionStrategy(model: ModelProfile, preference: PrepareOptions['strategy'] = 'auto'): { strategy: 'portable' } | { strategy: 'native'; adapter: NativeAdapter } {
  invariant(['auto', 'native', 'portable'].includes(preference), 'Unknown compaction strategy.');
  if (preference === 'portable') return { strategy: 'portable' };
  const capability = model.nativeCompaction;
  if (!capability || capability.status === 'unknown') nativeError('CAPABILITY_UNKNOWN', 'Resolve native compaction for the selected deployment or explicitly choose portable.');
  invariant(model.backend, 'Actual selected backend identity is required for capability resolution.');
  validateBinding(model.backend);
  if (!sameBinding(model.backend, capability.binding)) nativeError('NATIVE_BINDING_MISMATCH', 'Capability evidence belongs to another provider, endpoint, model, version or scope.');
  invariant(capability.evidence.trim(), 'Capability evidence is required.');
  if (capability.status === 'unsupported') {
    if (preference === 'native') nativeError('UNSUPPORTED_STRATEGY', 'This selected deployment does not support the requested native strategy.');
    return { strategy: 'portable' };
  }
  if (!sameBinding(model.backend, capability.adapter.binding)) nativeError('NATIVE_BINDING_MISMATCH', 'Native adapter and selected backend differ.');
  return { strategy: 'native', adapter: capability.adapter };
}
export function assertPortableHistory(state: SessionState): void {
  if ((state.nativeCheckpoints ?? []).some((checkpoint) => !checkpoint.portableComplete)) {
    nativeError('NATIVE_MATERIALIZATION_REQUIRED', 'Stored native output includes content without a complete portable projection; materialize it explicitly before migration.');
  }
}
export async function countNative(adapter: NativeAdapter, request: NativeRequest, previous?: NativeCheckpoint): Promise<number> {
  const value = await adapter.countTokens(structuredClone(request), previous ? structuredClone(previous.response) : undefined);
  invariant(integer(value), 'Native counter must report nonnegative effective provider-input tokens.');
  return value;
}
export function validateNativeCheckpoint(checkpoint: NativeCheckpoint, state: SessionState, previous?: NativeCheckpoint): void {
  validateBinding(checkpoint.binding);
  invariant(checkpoint.previousId === (previous?.id ?? null) && integer(checkpoint.sourceRevision) && checkpoint.sourceRevision < state.revision, 'Invalid native checkpoint revision or chain.');
  invariant(integer(checkpoint.baseSequence) && integer(checkpoint.throughSequence) && checkpoint.baseSequence <= checkpoint.throughSequence
    && checkpoint.throughSequence <= state.messages.length && checkpoint.throughSequence >= (previous?.throughSequence ?? 0)
    && state.messages[checkpoint.throughSequence - 1]?.id === checkpoint.throughId, 'Invalid native raw coverage.');
  invariant(JSON.stringify(checkpoint.publicMessageIds) === JSON.stringify(state.messages.slice(checkpoint.baseSequence, checkpoint.throughSequence).map((message) => message.id)), 'Native response/public-log association is invalid.');
  invariant(['compaction', 'response'].includes(checkpoint.phase) && ['raw', 'resumed', 'rebuilt'].includes(checkpoint.origin)
    && typeof checkpoint.portableComplete === 'boolean' && typeof checkpoint.fixedHash === 'string'
    && typeof checkpoint.responseId === 'string' && checkpoint.responseId.length > 0, 'Invalid native checkpoint metadata.');
  object(checkpoint.state, 'Native continuation state');
  object(checkpoint.request.body, 'Native request');
  invariant(checkpoint.request.headers && Object.entries(checkpoint.request.headers).every(([key, value]) => typeof value === 'string' && !/authorization|api[-_]key|cookie/iu.test(key)), 'Persist only protocol headers, never credentials.');
  json(checkpoint.response);
}
