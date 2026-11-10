# SessionWeave 接口与策略

SessionWeave 是 Node.js 22+、ESM、TypeScript 可嵌入库。核心没有运行时第三方依赖，支持文本与 JSON 工具消息；宿主负责提供商鉴权、模型调用、真实工具执行及领域幂等。从源码安装及最小运行示例见 [README](../README.md)，完整开发环境需要 Node.js 22.13+。可执行离线流程、宿主接线和辅助模块见[示例导航](../examples/README.md)。

## 按任务查阅

| 任务 | 参考 |
| --- | --- |
| 选择路径、记录消息和准备上下文 | [策略](#先选择策略)、[portable 流程](#显式-portable打开记录准备及回读) |
| 核算窗口或配置通用摘要 | [模型预算](#模型预算)、[摘要与检查点](#摘要模型与检查点) |
| 回读原文、处理工具或实现存储 | [原文分页](#原文按预算分页)、[工具与恢复](#工具与恢复) |
| 接入工作记忆及预生成候选 | [完整包](#工作记忆完整包与发布)、[候选采用](#固定前缀预生成与显式采用)、[OM](#om-工作记忆与-prepare) |
| 连接实际模型 | [Pi 与宿主](#pi-ai-与宿主契约)、[原生 API](native-api.md) |

## 先选择策略

`prepare()` 的 API 路径默认 `strategy: 'auto'`，先判断能力，再准备上下文。即使本轮尚未触发压缩，也需要明确能力状态。品牌、模型名称和 OpenAI 兼容格式均不构成原生能力证据。

| 选择与能力 | 当前行为 |
| --- | --- |
| `auto` + 当前部署已确认支持 | 返回 `NativePreparedContext`，走原始协议适配器 |
| `auto` + 当前部署已确认不支持 | 选择 portable；配置工作记忆引擎或已有完整包时走工作记忆路径，否则沿用通用摘要基线 |
| `auto` + 缺少证据或 `unknown` | 抛出 `CAPABILITY_UNKNOWN`，不静默调用通用摘要 |
| 显式 `native` | 需要匹配的支持证据；明确不支持时抛出 `UNSUPPORTED_STRATEGY` |
| 显式 `portable` | 按 open 配置及已发布状态选择工作记忆或通用摘要路径；完整包的处理范围见下文 |

普通 API 选项返回 portable/native 联合类型，调用方按 `context.strategy` 分支处理。两种上下文的发送和响应提交方式不同。原生配置、`accept()`、完整状态回读和运行时委托见 [原生接口](native-api.md)。

## 显式 portable：打开、记录、准备及回读

下面演示已有通用路径。`targetModelProfile`、`summarizer`、实际响应和用量由宿主提供；原生路径使用 `accept()`，不把响应手动再追加一遍。

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
  strategy: 'portable',
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

`inspect()` 返回修订、原文数量、通用检查点、原生及工作记忆检查点元数据和 `pendingCallIds`。`read({sessionId,startId,endId})` 原样返回包含首尾 ID 的连续原文范围；传 `nativeCheckpointId` 或 `workingMemoryCheckpointId` 则返回对应完整检查点，均只允许当前会话。打开会话及回读均不调用模型或执行历史工具。

## 原文按预算分页

`readPage(reference, {maxTokens, countTokens, cursor?, signal?})` 是独立于 OM 的只读呈现接口，使用现有 read 的完整不可变原文。可以从工作记忆 sources 的总范围进入，也可以传任何当前会话中真实的连续原文范围；它不查询语义索引，不执行工具或调用模型。

```ts
const page = await session.readPage(
  { sessionId: session.sessionId, startId: 'first-evidence', endId: 'last-evidence' },
  {
    maxTokens: remainingForThisToolResult,
    // 计入整个 page，以及真实 call ID、工具名、结果格式等提供商封装。
    countTokens: (page) => hostCounter(encodeCurrentToolResult(page)),
    // 下一次读取时传上一页的 nextCursor；done 后停止。
    ...(previousPage?.nextCursor ? { cursor: previousPage.nextCursor } : {}),
  },
);
```

可直接运行 [raw-pages](../examples/raw-pages.mjs)：`npm run example:raw`。它使用明确的保守字节估计核算完整工具结果封装，不使用 OM 或 API。

返回 `RawPage` 中的字段全部属于被计数的页载荷：

| 字段 | 含义 |
| --- | --- |
| version / format | v1；`sessionweave-message-json@1` 表示本页 text 是单条完整 Message 的规范 JSON 片段 |
| range / rangeDigest | 请求的完整原文范围，及格式、范围、全部源记录的 SHA-256；不绑定会话 revision 或检查点 |
| source / sequence | 本页实际来自的单条原文引用及原始 sequence；source 的 startId=endId，使用 SW 原文 ID |
| position | `{unit:'utf16-code-unit', start, end, total}`；在该条规范 JSON 中的半开区间，不是 message.text 中的位置 |
| text | 该区间的原样片段；不会拆开 UTF-16 代理对。按 source ID 拼接该条所有页，再 JSON.parse，可还原整条记录，包括长工具参数／结果和其他元数据 |
| done / nextCursor | 整个选定范围是否读完，及下一位置的不透明游标；done=true 时 nextCursor=null。单条记录结束不一定是整个范围结束 |

每页只呈现一条消息的一个片段，最大 65,536 个 UTF-16 单元。单条长记录可以继续；下一页从完整原文推进，不从 OM formatter 的受限文本推进。片段本身可能不是完整 JSON，也不是可独立发送给模型的原始 tool 协议消息；宿主应把整个页作为当前只读工具的结果呈现，不把历史片段 append 回 canonical raw。

游标包含范围内容身份、原始消息 ID 与偏移；可 JSON 保存、重开／跨进程使用，并允许后续页采用不同预算或计数器。追加范围以外的新消息不会使旧游标失效。范围、原文内容或格式不匹配，以及非法／越界／拆开代理对的游标返回 `INVALID_READ_CURSOR`。游标不是权限令牌，读取仍按当前明确会话和原文引用执行。

`countTokens` 必须核算**整个页对象和宿主真实工具结果封装**，包含引用、元数据、续页游标、角色／call ID／工具名等成本，而非只数 text。库给计数器防御副本，只返回实际计数不超 maxTokens 的页；不假定 tokenizer 随前缀长度单调，也不承诺找出最大的可容纳页。最小非空片段及完整续页封装仍装不下时明确返回 `CONTEXT_BUDGET`，没有空页或隐藏尾部截断。

本页满足预算仅相对于宿主提供的计数依据和本页预算。宿主计算本轮剩余空间，并将返回的**整页**纳入最终模型请求的计数；单页成功不保证整个上下文满足窗口。模型是否主动回读、定位正确证据和正确使用证据尚无真实交互验证。source 表示实际原文位置，不是逐事实归因或自动检索保证。底层仍全量加载会话／范围，不改善长期存储规模。

## 稳定身份与动态材料修订

`prepare.materials: {id,text}[]` 保留原有的本轮快照语义，放在历史前方；修改它仍会改变较早的请求前缀。需要保持版本历史及生效顺序时，使用 `updateMaterials` 保存独立的材料修订，而不是把内容哈希当作材料身份反复替换快照：

```ts
await session.updateMaterials([
  { id: 'reference', version: 'v1', action: 'set', text: originalReference },
], { expectedRevision: (await session.inspect()).revision });
const first = await session.prepare({ strategy: 'portable', model, outputReserveTokens: 4000 });
// 发送 first，按其 revision 保存真实响应，完成全部真实工具结果。

await session.updateMaterials([
  { id: 'reference', version: 'v2', action: 'set', text: correctedReference },
]);
const next = await session.prepare({ strategy: 'portable', model, outputReserveTokens: 4000 });
// 直接发送 next；不在 prepare 之后重排、补贴或拼接材料。

await session.updateMaterials([{ id: 'reference', version: 'v3', action: 'withdraw' }]);
const original = await session.read({ sessionId: session.sessionId, materialId: 'reference', version: 'v1' });
```

`id` 是宿主的稳定材料身份，`version` 是明确的内容修订身份（各限 512 字符）。每个 set 完全替代同一身份的旧内容，非增量补丁；withdraw 无 text，保留明确的撤回墓碑。已撤回材料可以用新的版本再次 set。它们只表达宿主选用的材料及其断言，不证明内容真伪，也不引入领域材料类别。

每个批次单独原子提交，增加会话 revision，返回 `{revision,sequences}`。SW 捕获当时完整原文末尾作为 `afterSequence`，分配材料流中连续的 `sequence`，保存提交 `revision` 和同一身份的 `previousVersion`。宿主不能回填生效位置、改写原件或复用版本掩盖修改。材料是独立来源记录，不增加原始 Message 数，不伪装成用户原话。同一批次可以依次修订一个身份，顺序即生效顺序；未完成工具调用时禁止更新，以免拆开协议组。

重复提交原有完整有序批次且内容一致时不增加修订；不同内容、批次部分重放、顺序变化或同批次重复版本会失败。重试历史批次只返回当前修订，不会重新激活旧版本。`expectedRevision` 为可选 CAS 条件；材料修改也会使尚未保存的旧 actor 响应失效。取消在提交点前生效，失败和修订冲突不部分发布材料。需要在消息与材料之间协调业务事务的宿主，应明确调度提交和请求，而非把两个存储事务当成一个。

`inspect().materials` 返回每个身份最新的 `{id,version,action,sequence}`（含撤回）；`read({sessionId,materialId,version})` 回读完整不可变 `MaterialRevision`。可沿 previousVersion 追溯原件及生效位置，并与原始消息、历史决定及其当时理由核对。仅允许当前会话；返回防御副本。宿主可把这个读取入口接为只读工具，SW 不自动执行回读或检索。同一身份不得同时出现在新修订流与旧 `prepare.materials` 快照中。

portable 默认把每个版本投影到其原文锚点之后。旧投影的 ID、文本及零值合成时间保持稳定；没有新版本时不新增消息。通常下一版本追加在已有请求尾部，保留已有输入前缀。每个投影明确：同一身份按顺序取最后生效版本，后续替换／撤回使旧材料及历史记忆中的旧材料断言仅作为历史证据，不能继续当作当前材料事实；历史决定的原始理由不因此重写。这是投影契约，不是模型语义遵从的证明。

Handoff／OM 引擎继续只消费 canonical raw；材料不混入原文摘要、OM state 或工作记忆 sources。最终请求独立投影当前材料及其版本关系，旧记忆可能仍记载当时的断言和理由，须以材料修订的有效性说明核对。旧版本全文一直可回读。固定前缀 ticket 期间发生材料事务会破坏“仅追加原文”的证明，采用时返回 `REVISION_CONFLICT`，不能把旧候选视为已经处理新材料。

最终结果在存在持久材料时附带 `materialProjection`：

| 字段／模式 | 含义 |
| --- | --- |
| throughSequence | 最后一个已提交材料事件的序号，不是 raw sequence |
| totalRevisions / retainedRevisions | 已存档修订数／实际投影修订数，含撤回 |
| timeline | 保持材料事件顺序，正常请求不改写此前投影 |
| checkpoint | 压缩覆盖范围内，同一材料的旧正文折叠为该范围末尾版本；范围之外仍按锚点追加 |
| current | 材料历史造成预算压力时，仅投影各身份最后修订；撤回及原件身份仍保留 |

折叠不会修改存档或删掉当前材料正文；保留版本仍在自己的可用锚点生效，已压缩的锚点移至历史投影之后。SW 对候选完整请求重新计数，仅在确实减少核算量时采用预算折叠，实际材料投影也参与 usage 校准身份。必要折叠、记忆更新、固定指令／工具变化或模型切换都可能改变前缀。当前材料、撤回及受保护输入仍装不下时明确返回 `CONTEXT_BUDGET`，不能用缓存需求阻止必要压缩或截断原件。不保证提供商缓存命中率；最终缓存还取决于真实序列化与服务端策略。

当前原生适配器使用最新材料状态，修订变化后从 canonical raw 重建并标明 `origin:'rebuilt'`／`rebuildReason:'fixed-input-changed'`，不续用旧不透明检查点冒充新版本已生效。它们不承诺 portable 的逐锚点前缀复用；原文不完整或重建超出原生端点容量时失败，见[原生材料范围](native-api.md#材料修订与原生状态)。runtime 委托无法投影这套修订流，存在持久材料时拒绝委托。

### 材料存储升级与降级恢复

MemoryStore／FileStore 支持 `supportsMaterialRevisions: true`。自定义存储必须在同一 CAS 事务中追加 `Mutation.materialRevisions`，保留所有旧原文、检查点、用量与材料，声明能力后才可写入或打开材料存档；否则返回 `MATERIAL_STORAGE_UNSUPPORTED`。

旧接口和 SessionState v1–v3／FileStore manifest v1–v4 继续兼容，尚未保存材料的会话按原格式写入。首次材料提交使用 SessionState v4，增加非空 materialRevisions 和原文 appendLog；manifest v5 引用 `materials/material-<sequence>-<sha256>.json` 中的完整原件，保留其他记录。来源字节哈希、顺序、前驱、事务修订和闭合原文锚点均验证；缺失或损坏的已提交来源报错，未引用的中断文件不生效。材料与 manifest 的原子发布方式与原文相同。

旧版本读取器会拒绝这些新存档。升级前备份完整目录／数据库；降级需恢复升级前的完整备份，或由宿主显式迁移材料原件、建立新会话并核对有效版本。不能只降低版本号或丢弃材料数组。已发布的包、标签及附件不改写。

## 模型预算

`ModelProfile` 包含明确的 `id`、真实 `contextWindow`、可选 `maxOutputTokens` 和 `countTokens(input)`。ID 应包含提供商、模型及计数器修订。计数器需计算最终发送的完整输入：系统指令、工具声明、材料、交接状态和活动消息；供应商特定序列化由连接层计算。

以上 `countTokens(ModelInput)` 用于 portable 路径。原生配置另外提供 `backend: NativeBinding` 和 `nativeCompaction: NativeCapability`，按实际提供商、端点、模型、接口版本、作用域、协议和能力匹配；原生计数使用适配器的 `countTokens(NativeRequest, previousRawResponse?)`。不能将 `estimateInputTokens` 用于不透明原生状态。详见 [原生计数与能力](native-api.md)。

可用输入 = 窗口 − 输出预留 − 安全余量。安全余量默认窗口的 3%，`compactAt` 默认可用输入的 85%，`keepRecentGroups` 默认 2。没有统一 16K 上限。首次没有真实用量时可显式使用 `estimateInputTokens`，这是按 UTF-8 JSON 字节计算的保守估算，不是供应商 tokenizer，也不保证所有模型都不会超限。

portable 的实际用量通过 assistant 响应的 `usage` 保存。只有模型/计数器、固定指令与材料、检查点和保留消息前缀兼容时，才用最近观测修正估计偏差；切模型或压缩后不会沿用旧窗口/旧用量。`inputTokens` 必须是包含缓存命中的完整输入量；Pi helper 将独立的 input、cacheRead、cacheWrite 合计。推理输出也需计入宿主设置的输出上限。原生响应的原始用量随完整响应归档，不套用这一校准规则。

超过触发线且有合法历史范围时，`prepare()` 调用摘要模型。始终保留最新 user 原文和近期完整协议组。并行工具请求及其所有结果是一个组，不能被裁成孤儿结果。单条输入、工具组或固定材料过大时明确抛出 `CONTEXT_BUDGET`，保留原文，不截断或编造成功。

## 内部压缩调用的真实用量观测

注入的 SDK 模型已能观测每次 Observer／Reflector 的原始 finish usage，原生 compact transport 已能取得完整响应，JSON Summarizer 的宿主 generate 同样拥有原始模型响应。SW 不另建用量／计费账本；主回复与内部调用均由宿主包装模型／transport 后保存，避免把消息提交当作用量发生的唯一时点。

`getModelCallContext()` 提供 SW 才掌握的请求局部关联元数据。应在包装器进入调用时捕获它，然后在响应／流事件处使用捕获值；不要在离开该调用范围后查询“最后一次调用”。它不进入模型输入、存档或缓存前缀，不包含材料／研究正文、请求头或鉴权：

```ts
import { getModelCallContext } from 'sessionweave';

async function compactTransport(request, signal) {
  const call = getModelCallContext();
  // 宿主调用真实 endpoint，把原始 usage 和成功／失败／取消保存到独立观测系统。
  // 之后 SW 的候选校验、预算或 CAS 失败，不撤销这次调用的观测。
  return hostObservedCompact(request, { signal, call });
}
```

| 元数据 | 语义 |
| --- | --- |
| sessionId / sourceRevision | 发起内部调用时的会话及输入修订，不是后来发布的新修订 |
| phase | summary、observer、reflector、native-compaction；自定义工作记忆引擎外层为 working-memory |
| modelId | 本次模型／设置身份；自定义 working-memory 外层未选择模型时缺失，模型包装器仍知道实际 provider/model |
| checkpointId | 实际复用的前一检查点，重建或首次调用为 null；不把未发布候选当成新检查点 |
| throughId | 本次处理的闭合原文范围终点（适用时） |
| callId | 摘要、OM 实际 SDK 调用和原生 compact 的独立临时调用 ID；自定义引擎外层没有虚构的模型调用 ID |

范围使用 Node AsyncLocalStorage 隔离并发调用。直接调用 OM derive 也获得其请求的会话、阶段及修订关联；宿主模型保持原方法 receiver，Observer／自动与手动 Reflector 分别标记。取消信号传入 OM 的 SDK 调用，与 SDK 自身信号合并。范围本身不持有流；包装器必须在 doStream 进入时捕获元数据，不能依赖流由哪个异步消费者读取。

可复用的接线与完整离线演示见 [usage-observation.mjs](../examples/usage-observation.mjs)：

- `observeOmModel(model, record)` 包装 SDK v2／v3／v4，按原样转发流，在 SW 输出完整性检查之前保留 finish usage，覆盖失败、取消和已发生用量但未发布的候选。
- `observePiStream(start, record, {signal?,context?,usageOf?})` 在 Pi → SDK 转换之前观测原始流的 result promise，返回同一流对象，不额外消费 AsyncIterable。可保留分开的 input／cacheRead／cacheWrite／output，即使桥接层取消后先抛错、没有发出 SDK finish，稍后返回的用量仍可记录。
- `observeTransport(transport, record, {usageOf?,usageOfError?,statusOf?,context?})` 返回完整原始响应。可按实际 transport 的响应／错误契约提取用量和结果状态，不能假设所有错误都带 usage。默认识别 response.status 的 failed／cancelled，其余取 Promise 结果；其他提供商的正常返回错误须提供 statusOf。
- `record` 是宿主自己的记录回调。示例只提供接线，不是库内账本；部署时应独立持久化，不随 raw／checkpoint 事务回滚。记录回调失败不会改变原始模型结果。

每个真实调用选择一个保存计费用量的观测层。若同时包装 Pi 和 SDK 用于调试，它们可能共享 callId，不能把两层观测重复累加为两次调用。

记录中的状态表示模型／transport 调用的结果，不是检查点已发布的证明：完整响应之后的解析、预算、取消或修订冲突仍可能拒绝候选。保留 finishReason；截断输出的 usage 仍是真实消耗。失败、取消或缺少 finish 时，已观测字段保留，未知字段缺失；不能补 0 或把字符估计当作厂商计费用量。

SDK 和各提供商的普通输入、缓存读取／写入、输出及推理细项按实际形状保留；不同协议字段语义由宿主核对，不能盲目相加。`UsageObservation` 继续只用于容量校准，inputTokens 必须是包含缓存的完整输入总量，不是未缓存计费输入。费用聚合独立处理；SW 不内置价目表，不把 API 价格换算为订阅额度。

如果上游桥接已经合并缓存字段，SDK 外层包装无法恢复这些明细；应包装合并之前的 Pi stream 或最终 provider transport。Pi 示例标注 usageSource=pi-sdk，表示上游 SDK 报告值；SDK 自己的初始化零值、标准化字段及 cost 不等同于厂商原始计费证据，尤其不能直接用于订阅额度换算。需要精确区分未知字段时，在掌握原始响应的一层观测，或显式提供 usageOf，只返回实际已观测字段；SW 无法恢复上游已经丢失的信息。

主 actor 调用由宿主发送，位于这些内部调用范围之外；宿主使用返回的 PreparedContext／NativePreparedContext 关联 sessionId、revision、modelId 和 checkpointId。原生 server-threshold 的服务端压缩也发生在主调用中，使用其真实响应 usage，不虚构一个 SW 内部 compact 调用。runtime 内部开销由对应运行时提供，SW 无法通过委托计划获得。上述接线及离线回归不验证真实厂商账单或订阅额度。

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

选择原生时，自定义存储还必须声明 `supportsNativeState: true`，并在一个事务内提交 `nativeCheckpoint` 和公开响应消息。`MemoryStore`、`FileStore` 已实现此契约。FileStore 增加不可变的 `native-checkpoints/`；只有原生或通用状态时沿用 manifest v1/v2、逻辑 SessionState v1。工作记忆使用下节的新格式；新读取器继续读取旧 v1/v2 文件，旧读取器会拒绝更高版本。

## 工作记忆完整包与发布

`publishWorkingMemory(candidate, {signal?})` 保存一个完整、已经完成生成的候选，支持通过检查点回读。它不调用 OM 或任何模型，不将观察文字转换为六组 Handoff。

```ts
const before = await session.inspect(); // 在生成候选之前取得修订
// 可替换记忆引擎依据该修订的原文生成完整 JSON 状态；此处是确定性载荷示意。
const receipt = await session.publishWorkingMemory({
  complete: true,
  sourceRevision: before.revision,
  sourceThroughId: 'last-input-message',
  activeThroughId: 'last-activated-message',
  identity: { engine: 'example-engine@1', codec: 'example-state@1', policy: 'retain-research@1' },
  engineState: { rows: [], bufferedIds: [], cursor: 0 },
  projection: '供后续组装使用的历史工作记忆',
  sources: [{ sessionId: session.sessionId, startId: 'first-message', endId: 'last-activated-message' }],
});
const checkpoint = await session.read({ sessionId: session.sessionId, workingMemoryCheckpointId: receipt.checkpointId });
```

示意 ID 必须替换为当前会话已保存的真实 ID；引擎状态也必须替换为相应 codec 的完整编码，不能把示意对象当作 OM 恢复包。适配器负责把 Date 等转换为 JSON、携带恢复所需的全部状态，并使用包含版本／配置或内容摘要的 engine、codec、policy 身份。模型实例、鉴权和回调由运行配置提供，不装入状态包。核心检查 JSON、引用、范围和发布一致性，不证明某个引擎的编码闭合性或语义保真，也不建设通用 codec 注册框架。

`sourceThroughId` 是提供给候选引擎的闭合原文前缀终点；`activeThroughId` 是历史投影已代表的前缀终点，两者都不能拆开工具组，活动前缀不能超过输入前缀。缓冲内容可以留在 `engineState` 中，不能因此推进活动覆盖。活动为空时传 null，projection 必须为空、sources 必须为 []。非空投影的来源引用须在活动范围内且覆盖该前缀；这些是范围映射，不证明每句话都被来源支持。

SW 分配检查点 ID、时间、前一检查点引用、两个 sequence 和原文前缀摘要。`sourceRevision` 必须等于发布瞬间的修订；输入追加或其他提交都会使旧候选返回 `REVISION_CONFLICT`。完整包单独通过 `Mutation.workingMemoryCheckpoint` 发布，不能混入原文追加、用量或其他检查点。成功返回新 revision、checkpointId 和 activeThroughSequence，并产生 working-memory-committed 事件；原文不变。

MemoryStore 和 FileStore 声明 `supportsWorkingMemoryState: true`。自定义存储未声明支持时，发布或打开已有工作记忆会话返回 `WORKING_MEMORY_STORAGE_UNSUPPORTED`。存储必须一次保存全部包并保留其他历史；能力标志是适配器的事务承诺。

首次发布工作记忆后，逻辑 SessionState 升为 v2，增加非空 workingMemoryCheckpoints；FileStore manifest 升为 v3，引用 `working-memory/<id>.json` 中的完整包。载荷写完并同步后才替换 manifest，投影和引擎状态没有两个独立发布点。缺失、残缺、引用不匹配的已提交包会报错，未被 manifest 引用的中断文件不激活。旧 v1/v2 会话仍可读取；v3 会话后续追加或原生提交继续保留工作记忆记录。

打开、inspect 和 read 只恢复已提交 JSON 包，不运行生成、引擎更新或历史工具。portable prepare 已能消费该包的 projection；只有需要更新／重整记忆而未配置引擎时才返回 `WORKING_MEMORY_NOT_READY`。原生路径继续使用自身契约。

## 固定前缀预生成与显式采用

`precomputeWorkingMemory({throughId, reflow?, signal?})` 在 SW 捕获的固定闭合原文前缀上生成候选，返回当前 open 实例拥有的 `WorkingMemoryTicket`。它不发布、不准备 actor 请求，也不持有后台调度服务。throughId 必须位于完整协议组末尾，并包含实际 previous 已消费的输入；范围之外允许有正在等待真实结果的工具尾部，采用时再检查 pending。

```ts
const ticket = await session.precomputeWorkingMemory({ throughId: 'historical-assistant-id' });
// 期间宿主可继续 append。宿主随后为当前 user/run 选择新的请求边界及配置。
// 宿主先结束或废弃旧的在途 actor 请求，再明确采用候选。
const context = await session.prepare({
  strategy: 'portable', workingMemoryTicket: ticket,
  model: currentActor, systemPrompt: currentInstructions,
  tools: currentTools, materials: currentMaterials, outputReserveTokens: 2000,
});
// 仅按 context.revision 保存这次真实完成的主回复和用量。
```

运行 `npm run example:ticket` 查看 [离线完整示例](../examples/memory-ticket.mjs)。实际 OM runner 在生成中遇到新 user 追加，候选仍保留原始来源，由新的 prepare 使用当前配置显式采用，只生成一次。这个检查证明复用控制链，不证明摘要更准确或实际延迟改善幅度。

ticket 通过对象身份归属于原 open 实例；复制、JSON 序列化、重开或跨会话传递都不能采用，返回 `WORKING_MEMORY_TICKET_INVALID`。引擎／codec／policy 必须仍匹配，存储需声明 `supportsWorkingMemoryState:true` 与 `supportsWorkingMemoryProvenance:true`。ticket 没有跨进程待发布恢复；成功发布的完整包正常恢复。显式采用即使当前 raw 已装得下也会尝试发布，不会被 compactAt 悄悄忽略。

生成时捕获来源修订 R0、整个来源原文快照数量／摘要、实际 previous、处理前缀摘要、全部工作记忆／native／Handoff base 及源用量／追加元数据身份。新的 prepare 在最新读取 R1 上核对这些事实。只有从 R0+1 到 R1 的每一步都有连续的原文追加凭据、原前缀和所有 base 不变时，才允许复用。仅用量、空提交、其他检查点或策略变化，以及任何无法证明的缺口都会拒绝；不是把所有 revision 漂移都解释成追加。

`appendLog` 由核心 mutate 为仅含 messages（可附 usage）的非空原文追加生成，记录 revision 和连续 sequence 区间。原生响应带检查点、普通检查点、空提交等不产生这类凭据。它是可选优化元数据；旧的 raw／legacy 工作记忆 writer 如果丢弃凭据，将使已有 ticket 无法复用，不能因此猜测通过。自定义支持此能力的存储须原子保留凭据；不要求构建数据库或通用事件平台。

新 prepare 重新检查最新 pending、保护组及最新 user，按 activeThrough 接回所有必要原文尾部，用当前 system/tools/materials、目标模型和最终检查点 ID 完整计数，再以 **R1 做 CAS**。它不复用旧请求的 token 结果或 usage 偏差。计数期间再次追加仍冲突，宿主可在一次新的 prepare 中显式重试；旧 prepare 不自动吸收新 user。两个并发采用最多一个成功，已发布的 ticket 不能再发布。

生成、预算或发布前取消失败不改变旧包；预算不足或取消前尚未发布的 ticket 可在 base 仍有效时显式重试。发布后发生的新追加可能使返回前的修订检查失败，此时 ticket 已消费，宿主应重新 prepare 已提交状态，不能重复发布。其他已发 actor 响应依旧受 expectedRevision／usage.basis.revision 限制；本功能对在途 actor 不透明，调度与真实工具副作用仍由宿主负责。

采用后的包是 **WorkingMemoryCheckpoint v2**：`sourceRevision` 保留真实 R0，`publishedFromRevision` 保存发布前 R1，返回 context.revision／usageBasis.revision 为 R1+1。包还保存发布原文数量／摘要及 provenance：来源完整快照、所有 base、actual previous 和追加凭据。`inspect().workingMemoryCheckpoint` 同时给出来源与发布前修订；旧 v1 包的两者相等。

首次采用后逻辑 SessionState 升为 **v3**，FileStore manifest 升为 **v4**；完整包与凭据仍由一次 manifest 原子替换发布。读取验证按每个历史包的 R0／R1 重建当时 base，而非将旧包与当前最新 head 比较。新读取器继续支持旧 manifest v1/v2/v3、checkpoint v1 及无追加凭据的历史；v4／v3 状态不可丢失 provenance 或其引用的凭据。以后普通追加、原生更新或 strict v1 发布都保留 v4 格式和历史。

外部 `publishWorkingMemory(candidate)` 与未带 ticket 的普通 prepare 维持原有严格 sourceRevision 行为，不接受调用方重写来源来采用旧候选。只有此 SW 捕获且拥有的 ticket 接缝能生成带来源见证的 v2 包。

## OM 工作记忆与 prepare

`sessionweave/om` 提供 `createOmWorkingMemory()`，实际调用正式发布的 `@mastra/memory@1.39.0` Observer／Reflector。此入口要求 Node >=22.13，宿主安装这两个精确版本的可选 peer：

```sh
npm install @mastra/core@1.79.0 @mastra/memory@1.39.0
```

```ts
import { SessionWeave, MemoryStore } from 'sessionweave';
import { createOmWorkingMemory, RESEARCH_RETENTION_POLICY_V2 } from 'sessionweave/om';

const workingMemory = createOmWorkingMemory({
  model: hostSdkModel, // 明确的 LanguageModel V2/V3/V4 实例，由宿主提供鉴权
  modelId: 'provider/model/settings-revision@1',
  maxBatchTokens: 8000,
  observationTokens: 8000,
  maxOutputTokens: 4000,
  retentionPolicy: RESEARCH_RETENTION_POLICY_V2, // 可省略；需要旧策略时显式传 V1
});
const session = await SessionWeave.open({ sessionId: 'explicit-research-id', store: new MemoryStore(), workingMemory });
await session.append([{ id: 'question-1', role: 'user', text: '当前问题' }]);
const context = await session.prepare({
  strategy: 'portable', model: actorProfile, systemPrompt: currentInstructions,
  tools: currentTools, materials: currentMaterials, outputReserveTokens: 2000,
});
// 宿主发送 context；实际完成的公开 assistant 响应以 context.revision 追加。
```

完整离线流程见 [om-roundtrip](../examples/om-roundtrip.mjs)，运行 `npm run example:om`。它调用真实 OM runner，但底层 SDK 模型是确定性的离线替身，输出不代表语义质量。主入口没有静态加载 Mastra；已有 native／普通摘要使用者无需导入 OM 子入口。显式原生能力仍优先于 portable 引擎，原生错误不会触发 OM 重试。

同一个 open 配置 `workingMemory` 或旧 `summarizer` 中的一种。工作记忆路径从真实原文重建，不把旧 Handoff 当作原始证据。`WorkingMemoryEngine.derive()` 是单一候选生成接口，不是 codec 注册平台；可另行实现这一接口，但完整状态的闭合性仍由引擎负责。

prepare 首先复用身份兼容的已提交投影。请求超过 proactive 阈值且有可整理历史时，才调用引擎；切换较小窗口可请求一次反思重整。引擎仅返回隔离候选。SW 先创建最终检查点 ID，将历史投影、来源引用、当前 system/tools/materials、最新 user、受保护完整组和 **activeThroughSequence 之后**的原文一起计数；预算满足后才以同一 sourceRevision 原子发布完整包。buffer 输入不会被当成活动覆盖。装不下、生成失败、取消或新输入造成的 revision 冲突都保留此前包与全部原文，不发布半成品。

返回的 `origin:'working-memory'`、`synthetic:'working-memory'` 和 `checkpointId` 指向实际使用的包，usageBasis 绑定同一 ID。新检查点不继承旧包的用量偏差。没有配置引擎时仍可使用装得下的已有投影；需要更新时明确报错。重新打开并注入同一引擎／模型配置后，在下一次需要整理时恢复完整 OM 状态继续增量观察；单纯 open 或复用上下文不生成，也不回放工具。

默认研究政策为 `RESEARCH_RETENTION_POLICY_V2`，通过公开 observation.instruction／reflection.instruction 接入，沿用上游 Observer／Reflector 流程。V2 原样继承 V1 的 Observer 文本和共享保留规则，只替换反思引导：合并重复措辞，将过程记录压成发现、结果和剩余工作，同时保留仍影响续作的条件、失败信息及已记录理由；较旧或已完成本身不是删除依据。

共享规则继续保护对象—数值—单位—时间／采样与来源、勘误和旧决定当时的理由、逐成员状态、请求／协议结果／业务结果以及 unknown 的区别。`RESEARCH_RETENTION_POLICY_V1` 的原有 ID 和全文保持不变，可显式传入 retentionPolicy 固定旧策略及其检查点兼容身份。

宿主可传 `retentionPolicy: {id, observationInstruction, reflectionInstruction}` 替换完整政策。版本 ID 与两段完整正文一起进入 policy 摘要，并保存在 JSON 配置快照；任何一项变化均改变身份，由 prepare 从 canonical raw 重建，不把旧状态直接当成新政策的状态。它表达保留要求，不是模型遵从或内容无损的机械证明，也没有新增质量打分器。

省略 retentionPolicy 从旧默认 V1 切换到 V2 时，沿用上述身份不兼容处理：按需从原文重建，旧包仍保留，不给旧引擎状态换上 V2 标签。检查点／存储格式不变，也不增加压缩阶段或模型调用位置。这是指导取舍调整，不是已验证的语义质量提升。

当前支持面及限制：

- 固定 thread scope、手动 supplied messages、同步观察与反思，关闭异步 buffer、检索、额外 extractor／索引／working-memory 回调。状态包保存全部代、完整线程／消息／marker、资源行、来源映射及 Date 路径。模型对象、函数、凭据不进入 JSON；初始化记录使用明确的 JSON 策略配置。
- 候选使用新的 InMemoryStore；适配器在进程内全局串行执行、等待 settled，隔离同一 ID 的上游操作注册表。它不承诺与宿主自行创建的、使用相同 thread/record ID 的其他 OM 实例隔离。一个支持面外的活动／缓冲状态会被拒绝，不能直接导入任意外部 OM 数据库。
- SW sequence 决定精确增量。仅在导入候选 head 时清除时间过滤游标，并通过只读 beforeObservation 核对实际输入 ID；不改真实日期、旧代或已发布包。因而同毫秒／时间回退的新消息仍进入观察，之后也必须继续使用此适配器，不能改用 OM 自身的按时间加载。policy 身份记录这一约定。
- 真实 formatter 默认会把单工具结果限制在 5,000 估计 tokens，runner 未公开透传该预算。适配器比较相同输入的默认／无限工具 formatter；检测到截断时返回 `OM_INPUT_TOO_LARGE`，不能默默发布声称完整覆盖的记忆。readPage 只改善完整原文的证据呈现，不解除 OM 观察入口的这一限制；不把历史工具结果改写成伪造的分页交换。
- 本次 Observer／Reflector 的解析观察正文在 after 钩子按 `split('\n')` 检查，每行最多 10,000 个 UTF-16 代码单元（JS 字符串 `length`，不是 token）。超限返回 `OM_OUTPUT_TOO_LARGE`，错误说明阶段和单位，不附正文；不修剪或改写文本，也不因此增加调用或重试。OM 1.39 常规单行裁剪产物因追加后缀仍超限，会被拒绝；短的合法 `[truncated]` 引用允许通过。Reflector 后续 trim／分组可能使部分裁剪不再超限，因此这只是保留行的长度契约，不是完整裁剪检测或语义保真保证。失败不发布 SW 候选，但不承诺隔离 OM 域内较早阶段的写入全部回滚。
- 输出行检查只作用于本次新生成的观察正文；既有 V1／V2 指令及身份、检查点、codec 和存储格式保持兼容，已有包不重新生成或认证为从未裁剪。
- OM 压缩调用通过独立的 SDK 模型包装读取流式结束事件：v2 使用字符串 `finishReason`，v3／v4 使用 `finishReason.unified`。标准原因是 `length` 时，以 `OM_OUTPUT_INCOMPLETE` 拒绝本次候选，即使返回文本很短、XML 可解析也不发布；手动 reflow 保留这个错误，不被 `reflected:false` 的通用失败遮盖。错误不含正文或提供商原始原因，不增加补全、重试或模型调用。包装保留 SDK 方法接收者、模型元数据、公开 request／response 信息及其他流事件，宿主原模型和 actor 调用不受此包装接管。
- 结束检查只作用于本次 OM 生成，不回溯认证旧包；身份与状态格式无需迁移。它依赖 SDK 报告标准 `length`，不从文本或用量猜测中断，不把普通完成视为语义保真证明。`maxOutputTokens` 仍由宿主设置，单行长度、模型结束状态及最终 actor 预算分别校验。
- `maxBatchTokens` 是 OM TokenCounter 的粗略消息估计，不是完整提供商请求计数。只在完整协议组处拆批，一次最多 64 批；单组过大明确失败。旧记忆、OM 系统提示和提供商封装还占模型窗口，由宿主选择足够的模型／限制；供应商超限会使候选失败。主模型最终请求仍使用宿主计数器完整核算。
- `observationTokens` 触发原生 Reflector；`maxOutputTokens` 限制两个 OM agent 输出。host 的 modelId 必须随宿主模型／运行设置版本变更；保留政策的版本和正文另行进入身份。原生检查点更新或引擎身份变化时，从 canonical raw 重建。
- 取消会阻止后续步骤和最终发布；该版本 manual API 不接受宿主 AbortSignal，因此已开始的 OM 模型调用可能需要等待完成。宿主可另外在自己的模型连接层实现请求取消。

以上检查证明接线、覆盖边界、恢复、协议和发布条件；不证明 Observer／Reflector 保留了每个事实。长程语义质量、真实渠道和多模态仍需独立验证。原始存储与完整 OM 代仍随历史增长，当前按会话全量加载，不承诺存储有界。

文件锁遇到活动写入或崩溃遗留时返回 `STORE_BUSY`，不会猜测过期并抢锁。只有确认写进程已退出后，宿主才可移除相应空 `write.lock` 目录再重试。当前不承诺网络文件系统或断电后的完整硬件持久性，也不提供加密、垃圾清理或数据库索引。一次加载读入整个明确会话；大规模存储可在同一事务接口处替换。

## Pi AI 与宿主契约

[pi-host.mjs](../examples/pi-host.mjs) 展示显式 portable 路径中注入 Pi AI `complete()` 的接法。模块导出 `openPiSession()` 和 `requestModelStep()`，由宿主导入使用。调用 `requestModelStep` 时必须传 `strategy: 'portable'`；未选择或选择 native 会在发送前拒绝。`piModelProfile` 使用目录中的实际窗口，并将原生能力标为 `unknown`；`toPiContext` 转换标准消息及配对结果；`fromPiAssistant` 只提取已完成的公开文本/工具调用；`piUsage` 转换完整输入用量。

示例中的回调描述宿主连接层接口，不要求最终用户自行实现。API 鉴权、协议转换、渠道兼容和交互入口由宿主或已有连接层提供；实际模型窗口、有效 token 计数及原生能力也由该层传入。

Pi 的通用文本归一化不能作为原生块的无损通路。原生准备结果会被 `toPiContext` 拒绝；需要原生时，使用已确认能力的原始协议适配器，发送 `context.request`，再将完整响应交给 `session.accept()`。给 Pi 请求添加参数本身不能证明其响应解码和持久化支持原生状态。

切换 Pi 模型或容量更新后，需要用新的 `piModelProfile` 重新 `prepare`；桥接器会拒绝把旧的 prepared context 直接发送给另一模型或不同窗口。

当前只支持文本及明确命名的 JSON 工具内容。图像等未支持的公开内容、截断响应、不完整工具参数会拒绝入库，避免悄悄丢失内容。供应商 namespaced tools 需先在连接层映射到明确名称，Pi bridge 不悄悄丢弃命名空间。流式显示草稿由宿主管理，完成消息是当前存储原子。跨提供商工具 ID 的合法化属于模型连接层，核心拒绝重用调用 ID。

材料选择、成果版本和领域工具的操作幂等由宿主负责。已有原生智能体会话及压缩时，宿主可直接选择原生路径，避免对同一历史重复管理。离线测试和示例用于检查存储、协议、预算及发布条件；真实提供商兼容性与长期语义质量需按实际部署单独验证。
