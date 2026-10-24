# SessionWeave

可嵌入的跨模型持续会话与上下文库，适合使用普通模型 API 的 Node.js 应用。提供不可变原始记录、按实际模型窗口规划上下文、可替换 AI 摘要、检查点恢复和原文引用回读。

需要 Node.js 22+ 和 npm。核心没有运行时第三方依赖，使用 TypeScript + ESM：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run example
```

离线示例使用确定性替身演示压缩、重开和原文回读，不调用付费模型、不证明语义保真。接入真实模型时由宿主提供计数器、模型能力及摘要调用。

主要接口是 `SessionWeave.open()`、`append()`、`prepare()`、`read()`、`inspect()`。宿主继续负责提供商鉴权、材料选择、真实工具执行和操作幂等；恢复会话不会重新执行历史工具。

完整契约见 [接口说明](docs/api.md)，运行示例见 [quickstart](examples/quickstart.mjs)，已有 Pi AI 的应用可参考 [模型层接入示例](examples/qb-pi.mjs)。

当前为首轮 private 开发快照；`0.0.0` 是工程占位，没有正式版本、npm 发行或开源许可。支持文本和 JSON 工具消息，长期语义质量、真实提供商验证、多模态和大规模存储仍需后续完善。
