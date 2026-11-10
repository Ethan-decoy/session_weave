import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getModelCallContext, MemoryStore, SessionWeave } from '../dist/index.js';

// The host owns persistence/aggregation. These helpers never log a request, response body or key.
const cancelled = (signal, error) => signal?.aborted || error?.name === 'AbortError';
const select = (selector, value) => { try { return selector(value); } catch { return undefined; } };
function report(record, value) {
  try { void Promise.resolve(record(structuredClone(value))).catch(() => undefined); }
  catch { /* Observation cannot change a model result or hide its original error. */ }
}
const correlation = (context) => {
  try { return structuredClone(context?.() ?? getModelCallContext()); }
  catch { return undefined; }
};

/** Wrap native generate/compact or a host JSON-summary transport; keep the full response. */
export function observeTransport(transport, record, {
  usageOf = (response) => response?.usage,
  usageOfError = (error) => error?.usage,
  statusOf = (response) => ['failed', 'cancelled'].includes(response?.status) ? response.status : 'succeeded',
  context,
} = {}) {
  return async function (request, signal) {
    const call = correlation(context);
    try {
      const response = await transport.call(this, request, signal), usage = select(usageOf, response), status = select(statusOf, response);
      report(record, { call, status: cancelled(signal) ? 'cancelled' : ['succeeded', 'failed', 'cancelled'].includes(status) ? status : 'succeeded',
        ...(usage !== undefined ? { usage } : {}) });
      return response;
    } catch (error) {
      const usage = select(usageOfError, error);
      report(record, { call, status: cancelled(signal, error) ? 'cancelled' : 'failed',
        ...(usage !== undefined ? { usage } : {}), errorName: error?.name ?? 'Error' });
      throw error;
    }
  };
}

/** Observe Pi BEFORE an SDK bridge merges cache fields or rejects an aborted/error response.
 * Pi result() observes its final-result promise without consuming its AsyncIterable.
 * Return the exact original stream; never drain it, replace it, or request a second response.
 */
export function observePiStream(start, record, { signal, context, usageOf = (response) => response?.usage } = {}) {
  return function (...args) {
    const call = correlation(context);
    try {
      const stream = start.apply(this, args);
      void Promise.resolve(stream.result()).then((response) => {
        const reason = response?.stopReason, usage = select(usageOf, response);
        report(record, { call, usageSource: 'pi-sdk', status: cancelled(signal) || reason === 'aborted' ? 'cancelled'
          : ['error', 'length'].includes(reason) ? 'failed' : 'succeeded', finishReason: reason,
        ...(usage !== undefined ? { usage } : {}) });
      }, (error) => {
        report(record, { call, usageSource: 'pi-sdk', status: cancelled(signal, error) ? 'cancelled' : 'failed',
          ...(error?.usage !== undefined ? { usage: error.usage } : {}), errorName: error?.name ?? 'Error' });
      });
      return stream;
    } catch (error) {
      report(record, { call, usageSource: 'pi-sdk', status: cancelled(signal, error) ? 'cancelled' : 'failed',
        ...(error?.usage !== undefined ? { usage: error.usage } : {}), errorName: error?.name ?? 'Error' });
      throw error;
    }
  };
}

/** SDK v2/v3/v4 facade: capture raw usage BEFORE SW validates completion or publishes memory. */
export function observeOmModel(model, record) {
  return new Proxy(Object.create(model), { get(_facade, key) {
    const original = Reflect.get(model, key, model);
    if (key !== 'doStream' && key !== 'doGenerate') return typeof original === 'function' ? original.bind(model) : original;
    return async (options) => {
      const call = correlation(), actualModel = { provider: model.provider, id: model.modelId };
      let usage, reported = false, failureName;
      const finish = (status, extra = {}) => {
        if (reported) return;
        reported = true;
        report(record, { call, model: actualModel, status, ...(usage !== undefined ? { usage } : {}), ...(failureName ? { errorName: failureName } : {}), ...extra });
      };
      try {
        const result = await original.call(model, options);
        if (key === 'doGenerate') {
          usage = result.usage;
          finish(cancelled(options.abortSignal) ? 'cancelled' : 'succeeded');
          return result;
        }
        const reader = result.stream.getReader();
        return { ...result, request: result.request, response: result.response, stream: new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                finish(cancelled(options.abortSignal, { name: failureName }) ? 'cancelled' : 'failed'); // No finish: preserve any observable partial usage.
                controller.close(); return;
              }
              const chunk = next.value;
              if (chunk.usage !== undefined) usage = chunk.usage;
              if (chunk.type === 'finish') {
                const reason = typeof chunk.finishReason === 'string' ? chunk.finishReason : chunk.finishReason?.unified;
                finish(cancelled(options.abortSignal, { name: failureName }) ? 'cancelled' : failureName || ['error', 'length'].includes(reason) ? 'failed' : 'succeeded', { finishReason: chunk.finishReason });
              } else if (chunk.type === 'error') {
                if (chunk.error?.usage !== undefined) usage = chunk.error.usage;
                failureName = chunk.error?.name ?? 'Error'; // A later finish can still contain real usage.
              }
              controller.enqueue(chunk);
            } catch (error) {
              if (error?.usage !== undefined) usage = error.usage;
              finish(cancelled(options.abortSignal, error) ? 'cancelled' : 'failed', { errorName: error?.name ?? 'Error' });
              controller.error(error);
            }
          },
          cancel(reason) {
            finish(cancelled(options.abortSignal, { name: failureName }) || !failureName ? 'cancelled' : 'failed');
            return reader.cancel(reason);
          },
        }, { highWaterMark: 0 }) };
      } catch (error) {
        if (error?.usage !== undefined) usage = error.usage;
        finish(cancelled(options.abortSignal, error) ? 'cancelled' : 'failed', { errorName: error?.name ?? 'Error' });
        throw error;
      }
    };
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { createOmWorkingMemory } = await import('../dist/om.js');
  const { createOfflineOmModel } = await import('./om-fixture.mjs');
  const records = [], model = observeOmModel(createOfflineOmModel(), (record) => records.push(record));
  const workingMemory = createOmWorkingMemory({ model, modelId: 'offline/usage-demo@1', observationTokens: 100_000 });
  const session = await SessionWeave.open({ sessionId: 'usage-demo', store: new MemoryStore(), workingMemory });
  await session.append(Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: `Evidence ${index}` })));
  const options = { strategy: 'portable', model: { id: 'actor', contextWindow: 1000, countTokens: (input) => input.messages.some((m) => m.synthetic === 'working-memory') ? 200 : 950 },
    outputReserveTokens: 100, safetyMarginTokens: 0 };
  await session.prepare(options);
  let counts = 0;
  await session.prepare({ ...options, model: { ...options.model, countTokens: () => ++counts === 1 ? 950 : 200 } });
  console.log(JSON.stringify({ fixture: true, records }, null, 2));
}
