# 原生上下文与状态接口

本文描述原生压缩的接口、状态和离线协议契约。适配器的存在不证明某个真实模型、代理端点或账号可用；部署证据由宿主核实。项目状态和源码入门见 [README](../README.md)，通用消息、预算和工具规则见 [API 参考](api.md)。

## 能力与入口

主入口 `sessionweave` 导出 SessionWeave、原生类型、`confirmedNativeCapability` 和 `selectCompactionStrategy`。`sessionweave/native` 导出 OpenAI/Anthropic 适配器及 Anthropic Models 能力解析函数；`sessionweave/file-store` 提供 FileStore。核心不依赖厂商 SDK。

`NativeBinding` 包含 `provider / endpoint / model / apiVersion / scope / protocol / capability`。工厂从宿主的 `NativeBackend` 生成后两项；`ModelProfile.backend` 使用完整绑定。endpoint 必须是无凭据、无 query/hash 的 HTTP(S) 基址；scope 是稳定的部署作用域标识，不存放密钥。

`NativeCapability` 区分三种状态：

- `supported`：绑定、证据和适配器全部匹配。
- `unsupported`：有针对该绑定的明确不支持证据；`auto` 可使用现有 portable 基线。
- `unknown`：缺少或未核实证据；`auto` 与 `native` 均抛出 `CAPABILITY_UNKNOWN`。

`confirmedNativeCapability(adapter, evidence)` 记录宿主已核实的事实，不进行网络探测。它不能把品牌名称或“兼容 OpenAI”变成能力证明。`resolveAnthropicNativeCapability` 只解析宿主提供的 Models 结果：必须来自同一部署及相关 beta，模型 ID 一致，能力组及具体功能均为 true；缺失/null 为 unknown，明确 false 为 unsupported。连接层仍需保证查询与实际请求使用同一配置。

## 原生请求与响应提交

下面是宿主接线片段；实际端点、鉴权、完整响应提取和计数器由宿主提供。

```ts
import { SessionWeave } from 'sessionweave';
import { createOpenAINativeAdapter, confirmedNativeCapability } from 'sessionweave/native';

const adapter = createOpenAINativeAdapter({
  backend: selectedDeployment, // NativeBackend；实际端点、模型、版本及作用域
  mode: 'on-demand',
  generate: rawResponsesCreate,
  compact: rawResponsesCompact,
  countTokens: countEffectiveNativeInput,
});
const model = {
  ...selectedModelProfile, // 真实窗口、输出上限；portable 计数器仍是类型契约的一部分
  backend: adapter.binding,
  nativeCompaction: confirmedNativeCapability(adapter, deploymentCapabilityEvidence),
};
const session = await SessionWeave.open({ sessionId: hostSessionId, store });
await session.append([{ id: hostInputId, role: 'user', text: actualInput }]);
const context = await session.prepare({ model, strategy: 'native', outputReserveTokens: 4000, signal });
if (context.strategy !== 'native') throw new Error('Expected native context');
const rawResponse = await adapter.send(context.request, signal);
const receipt = await session.accept(context, rawResponse, { signal });
const artifact = await session.read({ sessionId: session.sessionId, nativeCheckpointId: receipt.nativeCheckpointId });
// 成功提交后，宿主才处理 artifact.publicMessageIds 对应的公开工具请求。
```

`NativeTransport` 接收 `{body, headers}` 及可选 signal，返回完整、普通 JSON 响应。headers 只包含协议版本/beta；transport 在发送时加入鉴权，不能把 Authorization、API key 或 Cookie 写回请求对象。SDK 类实例、流式草稿或只提取的文本不是原始响应，连接层须先得到完整 wire JSON。库不能验证回调实际发送到了哪个 URL。

`prepare()` 可能为 on-demand 模式调用 compact；普通生成由宿主显式调用 `adapter.send()`。`accept()` 将公开文本/JSON 工具投影和完整原生检查点一次提交。不要再手动 append 同一 assistant 响应。工具执行及副作用幂等继续由宿主管理。

必须把当前打开实例签发的原始 `context` 对象交回 `accept()`，且不得修改已计数的请求。克隆、序列化后恢复或另一实例持有的计划会被拒绝。同一对象和同一响应在成功后顺序重试返回 `replayed: true`；响应 ID 已在其他计划提交时拒绝重放。并发调用仍受修订比较约束，宿主不能据此重复执行工具。

## 已有协议模式

| 适配器模式 | 请求及下一轮状态 |
| --- | --- |
| OpenAI on-demand | 调用独立 compact endpoint；仅构造其支持的 model/input/instructions 字段；完整返回窗口作为下一轮 input，不只留下 compaction marker |
| OpenAI server-threshold | Responses 请求带 context_management/compact_threshold；input-array 模式追加全部 output；保留 compaction、reasoning 等原始项 |
| Anthropic on-demand | Messages 的 compaction summarize 请求及 compact-2026-09-04 beta；仅接受成功 compaction stop 与单个完整签名块，以 assistant content 窗口替换已汇总历史 |
| Anthropic server-threshold | compact-2026-01-12 beta、compact_20260112 edit 和至少 50000 的阈值；下一轮追加完整 assistant content，不采用 on-demand 的替换语义 |

OpenAI standalone 的整个 output 窗口必须保留；阈值模式可以保留完整输入数组。另可选择 `continuation: 'previous-response-id'`，但当前仅用于 server-threshold，需显式 `allowServerStorage: true`；下一轮只发送新输入及已保存的响应 ID。默认 input-array 使用 `store: false`。这些是本适配器的支持范围，不能推断为厂商对其他组合的统一限制。[OpenAI 官方压缩契约](https://developers.openai.com/api/docs/guides/compaction)

Anthropic on-demand 保存原响应作审计，但发送的消息只有 `{role:'assistant', content:response.content}`，不把整个 envelope 当作消息。签名、内容及数组顺序保持；SDK 注入的 `text:null`、`citations:null` 会被拒绝，连接层需正确提取 beta wire JSON。阈值与按需模式不混用。[按需契约](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)、[阈值契约](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)

完整原生结果不会转为六组 Handoff。标准公开文本和宿主 JSON 工具另外进入只追加原文；未知公开类型、引用等无法完整投影时保留原响应并标记 `portableComplete: false`，避免跨格式迁移时静默丢失。未实现显式解码的宿主工具类型会被拒绝。

## 计数、预算及错误

适配器的 `countTokens(request, previousRawResponse?)` 必须计算有效原生输入，包括不透明状态、指令、工具和材料。不得以密文字节估计 token；也不能把提供商累计费用或 compaction iterations 的总量直接当作当前活动窗口。原始 usage 完整归档，如何得到当前有效计数由已核实的连接层负责。

窗口减输出预留和安全余量形成输入预算。on-demand 使用 `compactAt`（默认 0.85）触发，compact 的原始输入仍须能装入目标窗口，候选返回窗口也必须通过预算，才发布检查点。server-threshold 的阈值须低于可用输入预算，prepare 仍要求本轮有效输入不超限；库不会以预计将发生的压缩替代计数。超限不截断历史。

| 情况 | 结果 |
| --- | --- |
| 证据缺失 / 绑定不匹配 | CAPABILITY_UNKNOWN / NATIVE_BINDING_MISMATCH |
| 自定义存储未显式支持原生事务 | NATIVE_STORAGE_UNSUPPORTED，提供商操作前停止 |
| 工具结果尚未齐全 | PENDING_TOOLS，不准备下一轮 |
| 窗口超限 / 新消息导致修订变化 | CONTEXT_BUDGET / REVISION_CONFLICT，保留已有状态及新原文 |
| 编辑计划 / 重复响应 ID | INVALID_STATE 或 NATIVE_PLAN_INVALID / NATIVE_RESPONSE_REPLAY |
| 公开内容不能完整迁移 | NATIVE_MATERIALIZATION_REQUIRED |

鉴权、超时、限流、服务端暂时错误和无效/不完整响应不表示“不支持”。错误原样报告或按结构校验拒绝，不自动重发 portable 摘要。取消在状态发布前生效，已经完成的原子提交不回滚。

## 持久化、续传和迁移

`NativeCheckpoint` 保存完整 binding、固定输入摘要、覆盖范围、上一检查点、公开消息关联、phase、origin，以及 request/response/state。保存的是 JSON 值和不透明字符串，不包含 HTTP 鉴权头或字节级 HTTP 报文。`read({sessionId,nativeCheckpointId})` 返回完整记录，`inspect().nativeCheckpoint` 只给元数据。

MemoryStore 和 FileStore 均支持公开消息与原生状态的单事务发布；自定义存储须声明 `supportsNativeState: true`。FileStore 首次原生提交升级为 manifest v2，并保留原文文件；打开和续传不会执行历史工具或自动再次生成。FileStore 仍全量加载、本地明文存储，不提供索引、加密或自动回收。

相同绑定和固定输入恢复最近的有效原生状态，再追加尚未覆盖的原文。绑定、系统指令、工具或材料改变，或显式 `rebuildNativeFromRaw: true`，会重新从公开原文构造，不携带旧不透明状态；`origin: 'rebuilt'` 及 `rebuildReason` 标记原因。严格匹配是项目的保守迁移约定，不等于所有厂商都禁止跨模型复用签名。切回 portable 也从公开原文重建，不沿用更早的 Handoff；需要新摘要时从原文生成，旧检查点仍保留审计链。

任何已归档原生输出缺少完整公开投影时，跨格式重建会被拒绝。当前没有自动 materialize 接口，宿主需另行设计完整迁移。原文或材料无法放入目标窗口时，明确失败；没有自动分段跨厂商迁移。

只恢复已提交检查点，不恢复尚在网络请求中的计划。若提供商已返回而进程在 `accept()` 前退出，宿主要协调实际响应和工具状态；不能序列化计划后盲目重发。模型回应先落盘、再执行工具、再追加真实结果的顺序保持不变。

已有完整原生运行时可使用 `prepare({runtime:{id,sessionId,capabilities:{persistentSessions:true,compaction:true},evidence}})` 得到 `RuntimePlan`。这只返回宿主声明的委托映射，不启动运行时、不镜像其历史、不准备 API 上下文；同一调用不能混入 model/strategy。

## 离线复现范围

运行 `npm run example:native`，再运行一次 `node examples/native-roundtrip.mjs`。示例检查不透明项和完整窗口续传、公开原文回读、稳定 ID，以及恢复时不调用生成/压缩。测试另覆盖独立进程恢复、取消、失败、修订冲突和 pending 工具。计数与响应均为 fixture，不代表真实提供商验收、压缩比或长期语义质量；实际接入组合需单独指定并验证。
