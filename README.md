# SessionWeave

为模型 API 应用管理可恢复的会话、原始记录和上下文预算。

SessionWeave 是一个 Node.js / TypeScript 库，可嵌入已有的模型调用流程：

- **保存与恢复会话**：按明确的会话 ID 追加原始消息，独立保存检查点，重启后继续工作。
- **准备模型上下文**：根据目标模型窗口、当前指令、工具和材料计算输入预算，保留近期完整的工具调用组。
- **选择压缩路径**：使用已确认可用的原生压缩，或通过可替换的工作记忆引擎／摘要器整理历史。
- **回读原始证据**：按消息引用读取完整记录，或在宿主提供的预算内连续分页。

模型连接、鉴权和真实工具执行由宿主应用提供。

## 项目状态

当前版本为 **`0.1.0-beta.1`**，是 private 预发布，提供源码和可安装的包附件，尚未发布 npm 包。版本内容与支持边界见[变更记录](CHANGELOG.md)，许可状态见[许可](#许可)。

基础入口要求 Node.js 22+、ESM。使用 OM 入口，以及安装本仓库的全部开发依赖并执行完整验证，需要 **Node.js 22.13+**。

## 使用预发布包

从 [GitHub 预发布](https://github.com/Ethan-decoy/session_weave/releases/tag/v0.1.0-beta.1)下载 `sessionweave-0.1.0-beta.1.tgz` 和 `SHA256SUMS`。仓库保持 private，需要具有访问权限。核对附件的 SHA-256 后，在宿主项目安装下载的包：

```sh
npm install ./sessionweave-0.1.0-beta.1.tgz
```

安装后可使用下方的相同包入口。需要 OM 时另行安装文档中固定版本的 peers，由宿主提供模型实例和鉴权。

## 从源码开始

在已有的仓库 checkout 中安装依赖并构建：

```sh
npm ci --ignore-scripts
npm run build
```

将下面的代码保存为仓库根目录的 `session-example.mjs`，执行 `node session-example.mjs`：

```js
import { SessionWeave, estimateInputTokens } from 'sessionweave';
import { FileStore } from 'sessionweave/file-store';

const session = await SessionWeave.open({
  sessionId: 'readme-example',
  store: new FileStore('.sessionweave/readme-example'),
});

await session.append([
  { id: 'user-1', role: 'user', text: '保存这个会话，稍后继续。' },
]);

const context = await session.prepare({
  strategy: 'portable',
  model: {
    id: 'offline-example',
    contextWindow: 8192,
    countTokens: estimateInputTokens,
  },
  outputReserveTokens: 1024,
});

console.log(context.messages);
```

这个示例准备一个离线上下文，数据保存在本地 `.sessionweave/readme-example/`。再次运行会打开同一会话；复用相同消息 ID 和内容时，原文不会重复追加。需要重新开始时，使用新的会话 ID 和存储目录。

示例中的窗口是演示值，`estimateInputTokens` 按 JSON 的 UTF-8 字节估算。实际接入时，使用宿主选定模型的真实窗口、输出上限和请求计数器，并由宿主完成协议转换与模型调用。

## 接入模型与工作记忆

每次请求前调用 `prepare()`。默认的 `auto` 策略需要实际部署的原生能力证据；缺少证据会返回 `CAPABILITY_UNKNOWN`。上面的离线示例显式使用 `portable`。

| 场景 | 接入方式 | 文档 |
| --- | --- | --- |
| 普通模型 API | 通过 `sessionweave` 准备上下文；宿主发送请求，再以准备时的 revision 追加真实响应 | [会话与预算](docs/api.md) |
| 已核实原生压缩的部署 | `sessionweave/native` 提供原始协议适配器，用 `accept()` 保存完整响应和续传状态 | [原生接口](docs/native-api.md) |
| 非原生工作记忆 | `sessionweave/om` 接入固定版本 Mastra Observer／Reflector，先验证最终上下文预算，再发布完整状态 | [OM 接入](docs/api.md#om-工作记忆与-prepare) |
| Pi AI 宿主 | `sessionweave/pi` 转换公开消息、模型容量和用量 | [宿主契约](docs/api.md#pi-ai-与宿主契约)、[接线模块](examples/pi-host.mjs) |

OM 是可选入口，使用 `@mastra/core@1.79.0` 和 `@mastra/memory@1.39.0`，模型实例由宿主提供。本文的源码安装包含这些开发验证依赖；基础入口不会加载 Mastra。

原始消息、原生状态和工作记忆检查点各自保留。恢复会话不会执行历史工具，工具副作用的去重与核对由宿主管理。

## 示例与文档

以下五个可执行示例都离线运行，无需 API 密钥：

| 命令 | 展示内容 |
| --- | --- |
| `npm run example` | 确定性摘要、文件持久化、检查点恢复与原文回读 |
| `npm run example:native` | 协议 fixture 下的完整原生窗口与续传状态 |
| `npm run example:om` | 真实 OM runner 配合确定性模型替身的观察、反思与恢复 |
| `npm run example:raw` | 完整原文按工具结果预算分页，支持长记录续读 |
| `npm run example:ticket` | 固定前缀预生成候选，由新的请求显式采用 |

各文件的用途见[示例导航](examples/README.md)。Pi 接线模块需要宿主注入连接与鉴权，OM fixture 为示例和测试提供离线模型替身。

进一步阅读：

- [API 参考](docs/api.md)：预算、工具配对、并发、存储与错误。
- [原生 API](docs/native-api.md)：能力证据、请求提交、状态恢复与迁移。
- [原文分页](docs/api.md#原文按预算分页)：完整记录的预算化呈现和游标。
- [候选预生成与采用](docs/api.md#固定前缀预生成与显式采用)：来源见证、追加凭据和发布修订。

## 支持范围

当前支持文本和明确命名的 JSON 工具消息。`MemoryStore` 用于内存会话，`FileStore` 用于本地文件持久化；文件存储按会话全量加载，不提供数据库索引、加密或自动回收。

预算不足、工具结果未齐全或请求修订过期时会明确失败，原始记录继续保留。OM 的输入格式、输出完整性和取消条件见 [OM 支持说明](docs/api.md#om-工作记忆与-prepare)。

现有测试和示例验证协议、预算、恢复及发布条件。真实提供商兼容性与长期语义质量仍需针对实际接入场景验证。

## 贡献与问题反馈

问题复现、开发环境、检查命令和贡献集成方式见 [贡献指南](CONTRIBUTING.md)。

## 许可

项目尚未选择开源许可证，当前 [package.json](package.json) 标为 `UNLICENSED`。
