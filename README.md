# SessionWeave

可嵌入的跨模型持续会话与上下文库，适合使用普通模型 API 的 Node.js 应用。提供不可变原始记录、按实际模型窗口规划上下文、可替换 AI 摘要、检查点恢复和原文引用回读。

需要 Node.js 22+ 和 npm，使用 TypeScript + ESM。可选 OM 入口要求 Node >=22.13 和固定 Mastra peers，开发安装包含这些验证依赖：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run example
npm run example:native
npm run example:om
npm run example:raw
npm run example:ticket
```

离线示例使用确定性替身演示 portable 压缩，原生示例使用协议 fixture 检查完整窗口、状态重开和原文回读。它们不调用付费模型、不证明语义保真。接入真实模型时由宿主提供实际部署能力、有效计数器及调用。

主要接口是 `SessionWeave.open()`、`append()`、`prepare()`、`accept()`、`read()`、`inspect()`。API 路径默认按已确认的实际部署能力选择原生；缺少证据会抛出 `CAPABILITY_UNKNOWN`。宿主可显式选择 portable 基线，Pi 示例也要求明确这一选择。宿主继续负责提供商鉴权、材料选择、真实工具执行和操作幂等；恢复会话不会重新执行历史工具。

完整契约见 [接口说明](docs/api.md)，运行示例见 [quickstart](examples/quickstart.mjs)，已有 Pi AI 的应用可参考 [模型层接入示例](examples/qb-pi.mjs)。

原生适配器、`accept()` 及状态恢复见 [原生接口](docs/native-api.md) 和 [原生离线示例](examples/native-roundtrip.mjs)。适配器存在不证明某个实际提供商、模型或渠道可用，需单独核实配置和协议。

非原生路径可通过 [OM 工作记忆](docs/api.md#om-工作记忆与-prepare) 接入正式发布的 Observer／Reflector。完整包包含恢复状态与历史投影；prepare 在完整目标预算检查后原子发布，重开后继续增量更新。见 [OM 离线示例](examples/om-roundtrip.mjs)。同步、文本／JSON、单工具输出和取消等支持限制以接口文档为准。

默认研究保留政策的版本和正文进入记忆身份；只读 [readPage](docs/api.md#原文按预算分页) 可按宿主计数依据与工具结果预算连续呈现完整原文，支持长记录及跨进程续读。它不解除 OM 观察入口的大工具限制；单页预算也不等于最终模型上下文预算。见 [纯 core 分页示例](examples/raw-pages.mjs)。

支持 [固定前缀候选预生成与显式采用](docs/api.md#固定前缀预生成与显式采用)，由新的 prepare 核对追加凭据／历史 base、使用当前请求配置重新计数并原子发布。ticket 不跨 open 实例或进程；已发布包携带完整 provenance 并可恢复。它不接管旧 actor 请求。见 [离线示例](examples/memory-ticket.mjs)。

当前为首轮 private 开发快照；`0.0.0` 是工程占位，没有正式版本、npm 发行或开源许可。支持文本和 JSON 工具消息，长期语义质量、真实提供商验证、多模态和大规模存储仍需后续完善。
