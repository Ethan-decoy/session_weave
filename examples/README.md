# 示例导航

在仓库根目录使用 Node.js 22.13+ 和 npm 安装完整开发依赖：

```sh
npm ci --ignore-scripts
```

## 可直接运行的离线示例

以下命令会先构建源码，再运行示例，无需 API 密钥：

| 命令 | 文件 | 展示内容 |
| --- | --- | --- |
| `npm run example` | [quickstart.mjs](quickstart.mjs) | 确定性摘要、文件持久化、恢复与原文回读 |
| `npm run example:native` | [native-roundtrip.mjs](native-roundtrip.mjs) | 原始协议 fixture、完整窗口和原生续传状态 |
| `npm run example:om` | [om-roundtrip.mjs](om-roundtrip.mjs) | 真实 OM runner 配合离线模型替身的观察、反思与恢复 |
| `npm run example:raw` | [raw-pages.mjs](raw-pages.mjs) | 按完整工具结果预算分页读取原始记录 |
| `npm run example:ticket` | [memory-ticket.mjs](memory-ticket.mjs) | 固定前缀预生成候选及新的请求显式采用 |

文件持久化示例将运行数据放在被 Git 忽略的 `.sessionweave/` 中，复用明确的会话 ID。检查条件和输出以各示例为准；这些离线流程不验证真实提供商可用性或长期语义质量。

## 宿主接线与辅助模块

[pi-host.mjs](pi-host.mjs) 导出 `openPiSession()` 和 `requestModelStep()`，展示宿主如何注入 Pi AI 的 `complete()`、模型、计数器和存储。它是供宿主导入的接线模块，没有独立运行入口；需要宿主提供实际连接和鉴权，调用时显式选择 `strategy: 'portable'`。原生协议接入使用原始适配器。

[om-fixture.mjs](om-fixture.mjs) 为离线示例和测试提供 SDK 模型替身。其确定性输出用于检查接线和发布条件。

接口细节见 [API 参考](../docs/api.md)及[原生接口](../docs/native-api.md)，开发验证命令见[贡献指南](../CONTRIBUTING.md)。
