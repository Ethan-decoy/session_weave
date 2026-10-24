# SessionWeave 首轮接口

SessionWeave 是 Node.js 22+、ESM、TypeScript 可嵌入库。核心没有运行时第三方依赖，支持文本与 JSON 工具消息；宿主负责提供商鉴权、模型调用、真实工具执行及领域幂等。当前为 private 开发快照，`0.0.0` 仅是工程占位，不代表正式版本或 npm 发行，尚未授予开源许可。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run example
```

示例离线运行，使用确定性摘要替身检验流程；再次执行会恢复同一明确会话，并按稳定消息 ID 去重。接入真实 AI 时更换摘要生成函数和目标模型计数器。

## 打开、记录、准备及回读

```ts
import { SessionWeave, createJsonSummarizer } from 'sessionweave';
import { FileStore } from 'sessionweave/file-store';

const session = await SessionWeave.open({
  sessionId: 'host-owned-stable-id',
  store: new FileStore('/host-owned/session-directory'),
  summarizer, // Summarizer；见下文。也可在尚不需要压缩时省略。
});
await session.append([{ id: 'stable-user-message-id', role: 'user', text: '继续上一轮任务' }]);
const context = await session.prepare({
  model: targetModelProfile,
  systemPrompt: '宿主的当前指令',
  tools: [],
  materials: [{ id: 'host-material-id', text: '本轮选择的材料' }],
  outputReserveTokens: 4000,
});
// 宿主发送 context，并把输出上限设置为同一 outputReserveTokens。
await session.append([{ id: 'stable-reply-id', role: 'assistant', text: actualPublicReply }], {
  expectedRevision: context.revision,
  usage: { basis: context.usageBasis, inputTokens: actualTotalInput, outputTokens: actualOutput },
});
const raw = await session.read({ sessionId: session.sessionId, startId: 'stable-user-message-id', endId: 'stable-reply-id' });
```

`append` 是一个原子批次，返回 revision 和稳定消息 ID。省略消息 ID 时生成 UUID；需要跨重试去重时由宿主保存并复用明确 ID。完整已存在的连续消息可重复提交而不增加 revision，内容变化、顺序变化和新旧混合重放会失败。模型响应写入使用准备时的 `expectedRevision`，冲突时重新组织上下文；先成功保存 assistant 工具请求，再执行工具。

`inspect()` 返回修订、原文数量、最新检查点与 `pendingCallIds`。`read()` 原样返回包含首尾 ID 的连续原文范围，只允许当前会话。打开会话及回读均不调用模型或执行历史工具。

## 模型预算

`ModelProfile` 包含明确的 `id`、真实 `contextWindow`、可选 `maxOutputTokens` 和 `countTokens(input)`。ID 应包含提供商、模型及计数器修订。计数器需计算最终发送的完整输入：系统指令、工具声明、材料、交接状态和活动消息；供应商特定序列化由连接层计算。

可用输入 = 窗口 − 输出预留 − 安全余量。安全余量默认窗口的 3%，`compactAt` 默认可用输入的 85%，`keepRecentGroups` 默认 2。没有统一 16K 上限。首次没有真实用量时可显式使用 `estimateInputTokens`，这是按 UTF-8 JSON 字节计算的保守估算，不是供应商 tokenizer，也不保证所有模型都不会超限。

实际用量通过 assistant 响应的 `usage` 保存。只有模型/计数器、固定指令与材料、检查点和保留消息前缀兼容时，才用最近观测修正估计偏差；切模型或压缩后不会沿用旧窗口/旧用量。`inputTokens` 必须是包含缓存命中的完整输入量；Pi helper 将独立的 input、cacheRead、cacheWrite 合计。推理输出也需计入宿主设置的输出上限。

超过触发线且有合法历史范围时，`prepare()` 调用摘要模型。始终保留最新 user 原文和近期完整协议组。并行工具请求及其所有结果是一个组，不能被裁成孤儿结果。单条输入、工具组或固定材料过大时明确抛出 `CONTEXT_BUDGET`，保留原文，不截断或编造成功。

## 摘要模型与检查点

`createJsonSummarizer({ model, outputReserveTokens, generate })` 将宿主模型调用转换为摘要依赖。`generate(input, {maxOutputTokens, signal})` 返回 `{text, complete}`，只有模型正常完成的 JSON 能进入候选。也可直接实现 `Summarizer`，替换整个生成过程。

摘要结构为 version 1，包含 `goals`、`constraints`、`decisions`、`completed`、`openQuestions` 和 `corrections` 六组。每项包含 `text` 和非空 `refs`，决定还包含 `rationale`。引用为 `{sessionId,startId,endId}`，必须能在覆盖的原始范围内解析；未知字段、空摘要、缺字段、虚构 ID、跨会话或越界引用均会失败。结构与引用正确不代表语义无损。

摘要请求把此前摘要和本次新增历史交给模型。库按摘要模型自己的窗口拆分完整组，逐块合并；所有块成功、目标上下文也容纳得下后，才一次提交最终检查点。切换到较小窗口、没有新增可裁历史时，可以保持覆盖范围重写旧摘要；未改变摘要的无效重写不会提交。失败、取消、不完整输出或修订冲突均保留上一有效检查点，原始消息从不替换。每轮最多 64 块，超出时明确失败。

摘要作为标注“不可信历史数据”的 user 上下文注入，不提升为系统指令。原文范围始终可读。检查点只影响活动上下文，不是新的公开 assistant 回复。

## 工具与恢复

```ts
await session.append([{ role: 'assistant', text: '', toolCalls: [{ id: 'stable-call-id', name: 'host_tool', arguments: {} }] }]);
// 宿主实际执行工具并处理幂等；包括取消后已发生的真实副作用。
await session.append([{ role: 'tool', callId: 'stable-call-id', name: 'host_tool', text: JSON.stringify(actualResult), isError: false }]);
```

调用 ID 在会话内唯一，结果名称和 ID 必须匹配；所有结果齐全前不接受新 user/assistant，也不准备下一次模型请求。恢复遇到未完成工具时返回 pending IDs，宿主核对真实结果后补记。库没有执行器，不会自动重做操作；工具“已执行但尚未落盘”的不确定状态必须由宿主的操作账本或幂等键协调。

存储接口只有 `load` 与追加式 `commit(sessionId, expectedRevision, mutation, signal?)`。自定义适配器必须在同一事务内比较修订并发布新状态，并在提交点前检查取消。`MemoryStore` 用于内存环境；`FileStore` 为本地文件系统保存不可变 `raw/` 与 `checkpoints/`，以一次 manifest 原子替换发布记录。未被 manifest 引用的中断写入不会变成已提交历史，缺失或损坏的已提交文件会明确报错。

文件锁遇到活动写入或崩溃遗留时返回 `STORE_BUSY`，不会猜测过期并抢锁。只有确认写进程已退出后，宿主才可移除相应空 `write.lock` 目录再重试。首版不承诺网络文件系统或断电后的完整硬件持久性，也不提供加密、垃圾清理或数据库索引。一次加载读入整个明确会话，适用于首轮嵌入验证；大规模存储可在同一事务接口处替换。

## Pi AI 与宿主契约

[qb-pi.mjs](../examples/qb-pi.mjs) 展示注入已有 Pi AI `complete()` 的接法，无需完整 Pi Agent、Codex 账号或 ACP。`piModelProfile` 使用目录中的实际窗口；`toPiContext` 转换标准消息及配对结果；`fromPiAssistant` 只提取已完成的公开文本/工具调用；`piUsage` 转换完整输入用量。历史中的推理签名和供应商加密状态不作为跨模型格式。

切换 Pi 模型或容量更新后，需要用新的 `piModelProfile` 重新 `prepare`；桥接器会拒绝把旧的 prepared context 直接发送给另一模型或不同窗口。

首版只支持文本及明确命名的 JSON 工具内容。图像等未支持的公开内容、截断响应、不完整工具参数会拒绝入库，避免悄悄丢失内容。供应商 namespaced tools 需先在连接层映射到明确名称，Pi bridge 不悄悄丢弃命名空间。流式显示草稿由宿主管理，完成消息是当前存储原子。跨提供商工具 ID 的合法化属于模型连接层，核心拒绝重用调用 ID。

研究节点、来源报告版本、材料选择、正式成果和工具操作幂等继续由宿主负责。已有原生智能体会话及压缩时，宿主可直接选择原生路径，避免对同一历史重复管理。本轮没有跨仓库产品接入、真实付费模型验证或长期语义保真评分；这些不影响基础存储和协议验证的独立进行。
