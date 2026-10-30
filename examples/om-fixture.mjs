/** Offline SDK model for wiring examples/tests. Its output is not a semantic evaluation. */
export function createOfflineOmModel({ onCall, output, specificationVersion = 'v2', finishReason = 'stop' } = {}) {
  const calls = [];
  return {
    calls,
    specificationVersion, provider: 'sessionweave-fixture', modelId: 'offline-om', supportedUrls: {},
    async doGenerate() { throw new Error('This fixture expects the real OM streaming runner.'); },
    async doStream(options) {
      const index = calls.length + 1;
      calls.push(options.prompt);
      await onCall?.({ index, prompt: options.prompt });
      const text = output ? await output({ index, prompt: options.prompt })
        : `<observations>\n* 🔴 (09:00) Offline fixture memory ${index}: preserve the recorded project decision.\n</observations>\n<current-task>Continue the recorded task.</current-task>`;
      const reason = typeof finishReason === 'function' ? await finishReason({ index, prompt: options.prompt }) : finishReason;
      const finish = specificationVersion === 'v2' || typeof reason !== 'string' ? reason : { unified: reason, raw: reason };
      const usage = specificationVersion === 'v2' ? { inputTokens: 20, outputTokens: 30, totalTokens: 50 }
        : { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 0 } };
      return { stream: new ReadableStream({ start(controller) {
        for (const chunk of [
          { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'fixture-text' },
          { type: 'text-delta', id: 'fixture-text', delta: text }, { type: 'text-end', id: 'fixture-text' },
          { type: 'finish', finishReason: finish, usage },
        ]) controller.enqueue(chunk);
        controller.close();
      } }) };
    },
  };
}
