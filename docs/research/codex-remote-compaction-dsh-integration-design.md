# OpenAI Codex remote compaction × DSH 插件接入设计核验

> 状态：研究核验 + 设计讨论，不是实现规格。第 1–12 节区分事实与边界，第 13 节给出基于证据的候选设计；本次未对用户账户做 live compaction 请求。
>
> 核验日期基线：全局 `@deepseek-ai/dsh` **0.1.1-rc.2**；插件安装的 `@earendil-works/pi-ai` **0.82.1**；Codex tag `rust-v0.147.0` 解引用到 `be6e8eac029b183056b7e4402879f15d2c85f61b`；研究时 `openai/codex` `main` 为 `b592a0bfed439386fadc69327bd49eccb074cdc6`。

## 1. 范围、证据规则与工作区基线

本文使用下列路径简称：

- `PLUGIN` = `/Users/suntc/project/dsh-plugins/dsh-codex-auth`
- `DSH` = `/Users/suntc/.nvm/versions/node/v22.21.0/lib/node_modules/@deepseek-ai/dsh`
- `PI` = `PLUGIN/node_modules/@earendil-works/pi-ai`

开始研究时，`git rev-parse --show-toplevel` 返回 `PLUGIN`；`origin` 与 main tracking 配置见 `PLUGIN/.git/config:8-13`，当前 HEAD 见 `PLUGIN/.git/HEAD:1`。`git status --short --branch --untracked-files=all` 显示已有且与本研究无关的未跟踪文件为：

- `docs/research/codex-remote-context-compaction.md`
- `docs/research/dsh-published-version-check.md`
- `docs/research/dsh-rc7-changes.md`
- `docs/research/dsh-rc7-plugin-surface.md`

这些文件在本研究中只读、未修改。本文是唯一新增文件。

已安装 DSH 的版本证据是 `DSH/package.json:1-4`；其发布依赖明确带入 `dsh-command-compact`、`dsh-compaction-basic` 与 `dsh-compaction-tool-result-pruner`，见 `DSH/package.json:30-40`。插件安装的 pi-ai 版本与仓库地址见 `PI/package.json:1-4`、`PI/package.json:87-94`；upstream tag `v0.82.1` 固定到 `b4f293684bba718d59cc1157679bcf6157b3a7f5`，其 package 版本证据为 [packages/ai/package.json#L1-L17](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/ai/package.json#L1-L17)。

Codex tag 的固定基线与既有研究范围见 `PLUGIN/docs/research/codex-remote-context-compaction.md:1-8`。本文重新执行了 `git ls-remote`：tag object 为 `3ed6f04f6bf8b7c46299d1cb1ff99c74ce21a51d`，解引用 commit 为 `be6e8eac029b183056b7e4402879f15d2c85f61b`；`main` 为 `b592a0bfed439386fadc69327bd49eccb074cdc6`。源码引用均固定到 commit，不引用易漂移的 `main` URL；issue 链接保留 canonical URL 以呈现当前状态。

## 2. 结论摘要

1. **DSH 的 compaction 生命周期应继续由现有深 Module 拥有。** `BasicCompactionEngine` 已统一掌握 trigger、range selection、tool-pair balance、durable lock、稳定性复核、surface replace、manual flush 与错误分类；为 Codex 单独复制或替换整套 engine 会丢失 Locality。证据：`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:548-616`、`:775-828`。

2. **`BasicCompactionEngine.summarize()` 本身不足以忠实承载 Codex remote compaction。** 它只返回 `SummaryResult` 文本块，而 v1 返回 canonical replacement `ResponseItem[]`，v2 返回 opaque `Compaction` item 并由客户端构造 replacement history。两者不是“远端文本摘要”的同一形状。证据：`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/index.d.ts:15-48`；[v1 endpoint](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/endpoint/compact.rs#L39-L88)；[v2 replacement builder](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L444-L491)。

3. **现有插件 adapter + pi-ai 0.82.1 只有 v2 request 注入的半条 Seam，没有 compaction output/replay Seam。** `onPayload` 足以追加 `compaction_trigger`，但 parser 不产出未知 `compaction` item；v1 还缺 unary `/responses/compact` operation。插件不能靠“多一次 fetch”补齐后续重放。证据：`PLUGIN/src/codex-auth-adapter.ts:147-168`；`PI/dist/types.d.ts:42-76`；`PI/dist/api/openai-responses-shared.js:544-598`。

4. **当前 plugin-only faithful 实现不能成立。** 插件自有 `CompactionEngine` + 完整 Codex `LlmAdapter` 在类型上可构造，但会复制 DSH compaction 生命周期与 pi-ai Responses serializer；而 shipped presets 的 isolated compaction row 也没有 bundle overlay Seam。该路径同时破坏 plugin-first 与 Locality，应拒绝。

5. **但 preset composition 缺口不是所有方案的必经路径。** 若作为单独 upstream 任务，在现有 prepared LLM Adapter Seam 上增加可选 provider-native compaction operation，并让已经安装在 shipped presets 内的 `BasicCompactionEngine` 保守调用它，就无需替换 `ctx.compaction`、无需新 preset row，也无需改 agent loop。COMMON CALLER 仍只调用 `compactIfNeeded()` / `compactNow()`。

6. **推荐“Dual Checkpoint”而不是 remote-only checkpoint。** 同一次 DSH transaction 始终产生 provider-neutral 文本 checkpoint，并可附带 Adapter-owned、versioned、lossless-JSON 的 provider-native checkpoint。同一兼容 Codex Adapter 使用 native replay；foreign Adapter、账户/model/codec 不兼容、插件移除或 payload 损坏时只使用文本。native 成功而文本失败时不得提交 remote-only checkpoint。

7. **实现协议应隐藏在 Codex Adapter 内。** 当前 Codex `main` 的 `remote_compaction_v2` 已是 stable/default-on，v2 retained-message budget 为 `64_000` tokens；v1 仍有公开 `/responses/compact` 契约。外部 Interface 不暴露 v1/v2，首版可按 rollout 风险选择 v2-primary/v1-fallback。pi-ai 最新发布版 0.84.3 的 `Message` union 仍只有 user/assistant/toolResult，源码中没有内建 compaction item，见 [v0.84.3 types.ts#L467-L526](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L467-L526)。

8. **因此建议先提交研究与 upstream Interface 提案，不在本插件内实现功能。** 任何 DSH core / `dsh-llm-pi-ai` 改动都必须是单独 scope，并经明确授权。

## 3. DSH 0.1.1-rc.2 的公开 seams

### 3.1 `@deepseek-ai/dsh-compaction`: backend 替换面

`CompactionEngine` 的最小 agent 输入只有 `session` 与可选 `provider/model`，手动路径额外要求 `runMaintenance`；这避免 backend 依赖 concrete agent-loop。见 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:38-59`。

三个 abstract 操作分别是：

- `compactIfNeeded(agent, 'pressure' | 'context-overflow', signal)`；
- `compactNow(agent, signal, sourceCommandId?)`；
- `compactRegion(start, end, agent, signal?)`。

它们的公开契约包括取消转发、balanced tool-pair 边界、range 是 surface-position span、replacement 使用 `compactCheckpointSource(compactionId)`。见 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:77-130`。

`CompactionResult` 必须保留 transaction id、start/summary/end seq、summary、被 shadow 的边界/全部 seq 与 token 估算，见 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/types.d.ts:100-130`。

### 3.2 DSH compaction 必须保留的 durable 数据

DSH 的 shared protocol 不是“删旧 messages 再插一段文字”，而是 append-only log 上的锁与替换事务：

1. `compaction/start`：`compactionId`、可选 `sourceCommandId`、turn owner；
2. `compaction/summary`：summary blocks、shadowed range、全部 shadowed seq、shadowed token count、provider、model、可选 maxTokens/usage，以及 marked `llm.stream` 时的完整 raw output；
3. 紧邻的 replacement `user/message`：`surfaceOp: replace` 与完整 source seq；
4. `compaction/end`：同一 id/owner 与可选 error。

事件字段见 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/types.d.ts:13-77`；共享事务顺序与 crash-lock 语义见 `DSH/node_modules/@deepseek-ai/dsh-compaction/README.md:39-59`。

`Session` 的 raw log 保持 append-only，事件及嵌套值在 acceptance 时 deep-freeze；`deriveMessages()` 只从 ordered surface 重建模型历史，replace 会让 shadowed nodes 从派生历史消失，但 raw events 仍在日志中。见 `DSH/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:166-212`、`:242-259`。

Surface 只允许 `user/message`、`assistant/message`、`tool/result`；replace 必须引用当前 surface 上的 start/end，并在 `sourceEventSeqs` 中覆盖全部 shadowed nodes。见 `DSH/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:360-410`。这意味着 faithful backend 仍须遵守 DSH 的 durable transaction，即便其 provider payload 是 Codex-native。

### 3.3 `dsh-compaction-basic`: 可复用与不可复用边界

Basic backend 的自动触发已通过公开 agent events 注册：`agent/pre-step` 做 pressure compaction，`agent/request-error` 在 canonical `CONTEXT_WINDOW_EXCEEDED` 时做一次受限 recovery，并在 surface generation 前进后要求 retry。见 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:775-828`。Agent-loop 文档也把 compaction 明确归为插件职责：pressure 用 `agent/pre-step`，overflow repair 用 `agent/request-error`，见 `DSH/node_modules/@deepseek-ai/dsh-agent-loop/README.md:74-83`。

Basic 的 pressure threshold 默认 `0.8`，retained tail 默认 `0.16`，summary cap 默认 `8192`，额外 compaction retry 默认 `1`，overflow retry 默认 `1`；支持精确 provider/model policy。见 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/types.d.ts:7-39`。

Basic 的唯一 subclass hook 是 `summarize(input, agent, signal)`；输入包含 replayed system、tools 与 selected messages，输出必须是 `SummaryResult`。见 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/index.d.ts:19-48`、`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/summarizer.d.ts:14-46`。

固定 transaction 会给 summary 加 checkpoint preamble/tag，并合成一个 user message，再检查 framed summary 小于 shadowed content。见 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:318-355`、`:548-560`。因此 override `summarize` 适合 template/remote **text summarizer**，不等于支持“远端返回 replacement history”。

### 3.4 profile composition seam

`standard`、`code`、`cordis` 三个已安装 preset 都把 `compaction` 与 `toolResultPruner` 放在 isolated Cordis group 中，并在组内加载一个 `@deepseek-ai/dsh-compaction-basic`、`command-compact` 与 pruner。证据分别为：

- `DSH/config/agent-presets/standard/agent.cordis.yml:126-155`
- `DSH/config/agent-presets/code/agent.cordis.yml:133-162`
- `DSH/config/agent-presets/cordis/agent.cordis.yml:114-143`

这证明 backend 是按 preset/agent realm 选择，不是 Host 全局单例。插件若提供 backend，composition 必须在该 isolated group 内替换 `compaction-basic`；仅注册一个顶层 Host row 不会自动取代这些 preset 内的 service。

当前插件 patch 只插入 `llm-codex-auth`、`codex-search`、`codex-image` 三个顶层 row，没有 compaction row 或 preset replacement，见 `PLUGIN/cordis.patch.yml:1-14`。更关键的是，profile boot 先按 bundle → profile → home → CLI overlay 顺序组合顶层 rows，随后若存在 `agent-presets` row，就追加一个内部 overlay，把 `config.roots` 设为仅含 `SHIPPED_PRESET_ROOT`；见 `DSH/lib/profile-boot-DG5t9aNs.js:156-188`。AgentPresets 又把可配置 roots 之后的 Harness-home user root作为唯一可选追加项，且 earlier root 胜出，见 `DSH/node_modules/@deepseek-ai/dsh-agent-presets/lib/types/index.d.ts:61-69` 与 `DSH/node_modules/@deepseek-ai/dsh-agent-presets/lib/types/preset.d.ts:46-56`。

所以当前公开 composition 并没有“npm bundle 给 shipped preset 打 nested patch”或“package 自带 preset root 加入 roster”的 seam。用户可在 Harness home 创建自己的 preset，但那是用户部署改动，不是本插件的 bundle-only faithful 集成。

### 3.5 LLM 与 provider-private replay seam

`LlmRuntime` 的公开 adapter API 支持 `registerAdapter(routes, adapter)`；`LlmAdapter` 负责 model info、prepare 与最终 `stream(options)` wire translation。见 `DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:117-168`、`:227-234`。

`GenerateOptions` 只携带 provider/model、provider-neutral messages、system、tools、sampling/cancel/sessionId，以及 auxiliary `purpose: 'compaction' | 'session-title'`；没有 provider-native `ResponseItem[]` 或 compact endpoint result。见 `DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:331-368`。

Assistant provenance 已有 adapter-private `replayState?: unknown`，但它只属于 model-produced assistant message，见 `DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:4-20`、`:134-150`。`dsh-llm-pi-ai` 当前 replay envelope 只保存 response identity 与 text/reasoning/tool-call signatures，见 `DSH/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/replay.d.ts:12-43`；converter 遇到 unsupported Harness block 会降级或拒绝，见 `DSH/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:176-218`。

普通 user history conversion 会 flatten text、单独转换 tool results，并忽略其他未知 user blocks；见 `DSH/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1139-1177`。所以仅通过 declaration merge 添加一个 Codex compaction block，并不会使现有 PiAiAdapter 把它序列化成 Responses `compaction` item。

## 4. 当前插件 adapter/patch 的实际边界

插件的 accepted design 指定：Auth/LLM row 复用 `PiAiAdapter` 与 installed pi-ai Codex catalog；普通 conversation streaming、tools、reasoning replay、usage、cancellation、compaction、attachments 由 PiAiAdapter 处理。见 `PLUGIN/docs/design.md:29-47`、`:69-77`。ADR-0002 也只为 standalone Search/Image 绕开 pi-ai，因为当时 pi-ai 无法表达这些 item，见 `PLUGIN/docs/adr/0002-compose-codex-capabilities.md:1-7`。

代码与设计一致：

- 从 `builtinProviders()` 取 `openai-codex`；
- 添加 Host-owned apiKey auth method；
- 仅覆写显示名与 context-window catalog；
- `stream` / `streamSimple` 原样 delegate 给 catalog provider。

见 `PLUGIN/src/codex-auth-adapter.ts:147-168`。

Adapter registration 是公开 `ctx.llm.registerAdapter([CODEX_ROUTE], new CodexAuthAdapter(...))`，route 冲突会 fail loud，见 `PLUGIN/src/index.ts:96-116`。Codex login token 每请求由 Host coordinator 注入，pi-ai ambient login/storage 被 fail-closed，见 `PLUGIN/src/codex-auth-adapter.ts:82-105`、`:193-215`。

Long Context Mode 只改已知 GPT-5.6 model descriptors 的 `contextWindow`，不改 wire request；见 `PLUGIN/src/codex-context.ts:8-17`、`:28-40`。项目词汇也明确它只是 default-off model policy，不是 backend entitlement/request parameter，见 `PLUGIN/CONTEXT.md:71-73`。

因此 remote compaction 若接入，认证可复用 `CodexAuthService.credential()`；但 endpoint/payload/output/replay 不能从当前 wrapper 自动获得。

## 5. pi-ai 0.82.1 能做什么、缺什么

pi-ai 的 catalog provider `openai-codex` 使用 base URL `https://chatgpt.com/backend-api` 与 `openai-codex-responses` API，见 `PI/dist/providers/openai-codex.js:6-16`。

普通 request builder 生成：`model`、`store:false`、`stream:true`、`instructions`、converted message `input`、text verbosity、`reasoning.encrypted_content` include、`prompt_cache_key`、tool choice、parallel tool calls，以及可选 tools/reasoning/service tier。见 `PI/dist/api/openai-codex-responses.js:365-415`。URL resolver 只解析普通 `/codex/responses`，见 `PI/dist/api/openai-codex-responses.js:443-458`。

`OpenAICodexResponsesOptions` 自身只增加 reasoning、service tier、verbosity 与 tool choice，见 `PI/dist/api/openai-codex-responses.d.ts:1-11`；它继承的 `StreamOptions` 另有 `onPayload` 与 `onResponse`。`onPayload` 可返回替换后的 unknown payload，`onResponse` 只暴露 status/headers，见 `PI/dist/types.d.ts:42-76`。Codex transport 确实在 dispatch 前调用 `onPayload`、收到 HTTP response 后调用 `onResponse`，见 `PI/dist/api/openai-codex-responses.js:171`、`:279`。

所以对默认 V2 而言，**request half 已可注入**：调用方可验证普通 Responses body 后，把 `{ type: 'compaction_trigger' }` 追加到 `input`。但 response half 缺失：shared parser 在 `response.output_item.done` 只 finalize reasoning、message、function call 与 custom tool call；其他 item 没有输出 callback，见 `PI/dist/api/openai-responses-shared.js:544-598`。`onResponse` 又在 body stream 消费前调用，只能看到 status/headers，不能取得 compaction item。

V1 仍缺 compact endpoint selector/unary decoder；V2 仍缺 raw output-item callback 或 dedicated compact operation，以及 replacement-history callback。已安装源码对 `responses/compact`、`compaction_trigger`、`compaction_summary` 无内建处理。

pi-ai 的 provider-neutral message union只有 user(text/image)、assistant(text/thinking/toolCall)、toolResult，见 `PI/dist/types.d.ts:225-250`、`:273-310`。它没有原生 Compaction message/item 类型。

结论：pi-ai 可以继续承担 normal Codex Responses；0.82.1 可用 `onPayload` 构造 V2 request，但不能观察 V2 compaction output，也不是完整 remote compaction client。

## 6. Codex remote compaction 的一手协议事实

### 6.1 `rust-v0.147.0` 基线

Tag 基线有三条实现：local Responses summarization、v1 `/responses/compact`、v2 `/responses` + `CompactionTrigger`。既有逐行研究见 `PLUGIN/docs/research/codex-remote-context-compaction.md:12-29`。

V1 canonical payload 字段为 `model`、完整 `input: &[ResponseItem]`、instructions、optional tools/reasoning/service tier/prompt cache key/text，以及 parallel tool calls，见 [tag common.rs#L26-L44](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/common.rs#L26-L44)。端点是 unary `POST responses/compact`，响应 JSON 是 `{ output: Vec<ResponseItem> }`，且读取 `x-codex-turn-state`，见 [tag endpoint/compact.rs#L35-L88](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/endpoint/compact.rs#L35-L88)。

V2 在普通 `/responses` 输入末尾追加空 `CompactionTrigger {}`，见 [tag compact_remote_v2_attempt.rs#L66-L79](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2_attempt.rs#L66-L79)。输出必须包含恰好一个 `ResponseItem::Compaction` 且 stream completed，见 [tag compact_remote_v2.rs#L385-L442](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L385-L442)。

`Compaction.encrypted_content` 对客户端不透明，`CompactionTrigger` 是 request control 而非 durable response item，见 [tag models.rs#L1020-L1031](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/models.rs#L1020-L1031)。

### 6.2 当前 `main` 快照（`b592a0bf…`）

当前 `main` 仍保留相同核心协议：

- `remote_compaction_v2` feature 是 stable 且 default-on；tag 与 current main 证据分别为 [tag features/src/lib.rs#L1467-L1476](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/features/src/lib.rs#L1467-L1476) 与 [current features/src/lib.rs#L1610-L1620](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/features/src/lib.rs#L1610-L1620)。
- provider capability 是 `Unsupported | V2`；OpenAI/Azure Responses provider 报 V2，见 [provider.rs#L44-L75](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/model-provider/src/provider.rs#L44-L75) 与 [provider.rs#L341-L353](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/model-provider/src/provider.rs#L341-L353)。当前 enum 不再单列 V1，但 feature 未开启时仍走 legacy remote path，见 [tasks/compact.rs#L41-L65](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/tasks/compact.rs#L41-L65)。
- v1 endpoint 常量与 unary timeout 仍是 `/responses/compact`，见 [client.rs#L164-L170](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/client.rs#L164-L170)。
- v1 payload 仍从 `model/input/instructions/tools/parallel_tool_calls/reasoning/service_tier/prompt_cache_key/text` 构造；current main 另有 optional `access_programs`，见 [common.rs#L45-L65](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/codex-api/src/common.rs#L45-L65) 与 [client.rs#L626-L635](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/client.rs#L626-L635)。
- v1 响应仍是 `CompactHistoryResponse { output: Vec<ResponseItem> }` 并回填 `x-codex-turn-state`，见 [endpoint/compact.rs#L35-L87](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/codex-api/src/endpoint/compact.rs#L35-L87)。
- v2 仍追加 `ResponseItem::CompactionTrigger {}`，见 [compact_remote_v2_attempt.rs#L69-L84](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2_attempt.rs#L69-L84)。
- v2 客户端保留合格消息、按 `64_000` token 预算截断，再把唯一 compaction output push 到末尾，见 [compact_remote_v2.rs#L74-L80](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2.rs#L74-L80) 与 [compact_remote_v2.rs#L486-L504](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2.rs#L486-L504)。
- `Compaction` 仍含 optional id、required opaque `encrypted_content` 与 optional internal metadata；trigger 仍声明为非 durable request control，见 [models.rs#L1190-L1208](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/protocol/src/models.rs#L1190-L1208)。

Model metadata 的 automatic compaction limit 默认取 context window 的 90%，显式 threshold 也 clamp 到该上限；tag 与 current main 证据分别为 [tag openai_models.rs#L418-L477](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/openai_models.rs#L418-L477) 与 [current openai_models.rs#L436-L498](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/protocol/src/openai_models.rs#L436-L498)。

当前 `main` 的触发位置仍覆盖 mid-turn context limit、pre-turn limit、comp-hash change 与 model downshift。Pre-turn 达阈值即触发；mid-turn 还要求 follow-up/pending work。见 [turn.rs#L415-L500](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/session/turn.rs#L415-L500)、[turn.rs#L1032-L1061](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/session/turn.rs#L1032-L1061)、[turn.rs#L1097-L1142](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/session/turn.rs#L1097-L1142)、[turn.rs#L1172-L1190](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/session/turn.rs#L1172-L1190)。

### 6.3 Codex faithful replay 必须保留什么

由公开客户端能证明的最小集合是：

1. **Opaque compaction item 本身**：至少 `type=compaction`、`encrypted_content`，以及响应给出的 id/metadata；客户端无权把它转成可读摘要。证据：[current models.rs#L1190-L1208](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/protocol/src/models.rs#L1190-L1208)。
2. **Replacement history 的顺序、角色与当前 context**：v1 安装服务端 output；v2 把 retained items 放在 compaction item 之前，并在安装前重建 canonical current initial context/world state。证据：[current compact_remote.rs#L284-L299](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote.rs#L284-L299)、[current compact_remote_v2.rs#L308-L353](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2.rs#L308-L353)、[current compact_remote_v2.rs#L486-L504](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2.rs#L486-L504)。
3. **下一请求的完整 envelope facts**：model、input、instructions、tools、parallel-tool flag、reasoning、可选 service tier/cache key/text。证据：[current common.rs#L45-L61](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/codex-api/src/common.rs#L45-L61)。
4. **Turn-scoped routing state**：同一 turn 收到的 `x-codex-turn-state` 要在后续请求回送，且不能跨 turn；见 [current client.rs#L274-L295](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/client.rs#L274-L295)。
5. **安装边界**：remote response 完成不等于 live history 已替换；Codex 通过独立 install/replace 步骤进入 session。v1 最终调用 `replace_compacted_history`，见 [current compact_remote.rs#L287-L299](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote.rs#L287-L299)；session 给缺失 item 分配 id 并持久化 replacement history，见 [current session/mod.rs#L3517-L3531](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/session/mod.rs#L3517-L3531)。

“faithful”还必须同时保留第 3.2 节的 DSH durable transaction；Codex rollout/window ids 不是 DSH session schema 的既有字段，不能未经新契约就假设必须一比一复制。

## 7. 可成立的实现层级判断

### 7.1 可以成立：remote text summarizer（但不能命名为 Codex remote compaction）

插件可以 subclass `BasicCompactionEngine`，override `summarize`，直接访问 plugin auth service 并调用一个远端文本摘要服务；Basic 会继续处理 lock、range、checkpoint 与 replace。该扩展点由 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/index.d.ts:19-48` 明确支持。

但 `/responses/compact` 的响应不是 `SummaryResult`，而是 `Vec<ResponseItem>`；把 opaque `encrypted_content` 解读成文字或丢掉 retained/output items 都没有证据支持。因此该实现只能被称为 remote text summarizer，不能声称 faithful Codex remote compaction。

### 7.2 当前组合下不能成立：保留 PiAiAdapter 的 faithful remote compaction

阻断链是：

1. Codex 产出原生 `ResponseItem::Compaction` / replacement `Vec<ResponseItem>`（第 6 节）；
2. Basic hook 只接受 summary blocks 并固定成一个 user checkpoint（第 3.3 节）；
3. 当前 DSH `GenerateOptions` 无 raw native item 字段（第 3.5 节）；
4. dsh-llm-pi-ai user conversion 不映射 plugin-native block（第 3.5 节）；
5. pi-ai 0.82.1 的 `onPayload` 只能补 V2 request half；parser 没有 raw compaction output callback，provider-neutral history 也没有 compaction item（第 5 节）。

因此不能通过“给现有 adapter 加一次 fetch”完成端到端 replay；下一普通 model request 仍会丢掉 compaction item。

### 7.3 仅代码类型上可构造，但不是当前 bundle-only 集成：插件拥有完整 adapter + engine

公开 DSH 类型 seams 允许插件代码定义：

- 一个 `CompactionEngine` backend；
- 一个 declaration-merged provider-native durable block/source；
- DSH log/surface replace transaction；
- 一个不再继承 PiAiAdapter 的完整 `LlmAdapter`，把该 block 展开回 Responses items。

依据分别是 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:67-75`、`DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:75-89`、`DSH/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:178-212` 与 `DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:117-168`。Token meter 对未知 block 有 JSON-length fallback，不会直接崩溃，见 `DSH/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js:19-38`。

但是两项事实阻止本文把它判为当前可交付方案：第一，它会推翻项目当前“provider protocol stays in installed pi-ai”的边界（`PLUGIN/src/codex-auth-adapter.ts:9-21`），并复制 ordinary Responses、tools、reasoning replay、transport、usage 与取消；第二，第 3.4 节证明 bundle patch 无法把该 engine 接入 shipped preset 的 isolated compaction group。用户手写 custom preset 可绕过第二点，但不属于插件自身安装 seam。因此本文只认定“类型上未封死”，不认定“当前 plugin-only faithful implementation 可成立”。

## 8. 插件自有 backend 路径的缺失 upstream seams（非推荐路径）

### 8.1 精确定义

若坚持让当前 npm bundle 自带一个 sibling `CompactionEngine`，证据不支持把缺口压成一个 API：至少有两个独立尺度。**DSH composition 缺口**负责把 plugin backend 选择进 shipped preset 的 isolated realm；**PiAiAdapter 复用路径的 wire/durability 缺口**负责 native item round trip。在后者内部，pi-ai wire 层最小缺口只是一个 raw `response.output_item.done` callback（或 dedicated V2 compact operation），因为现有 `onPayload` 已能追加 trigger；DSH 端到端仍需 adapter-owned、durable、provider-native history item round trip：

```text
remote compact response
  -> adapter-owned opaque durable value
  -> DSH compaction transaction installs replacement surface
  -> next GenerateOptions carries that value unchanged
  -> owning Codex adapter serializes it as native ResponseItem::Compaction
```

完整上游能力需要同时满足：

- bundle 可通过受支持机制对 shipped preset 的 nested rows 做 overlay，或按 provider/model 选择 compaction backend；该机制不能要求插件改写已安装 DSH 或用户配置；
- native history 值是 lossless JSON、provider/adapter-scoped，不向其他 adapter 泄漏；
- session persistence/replay 后仍可用；
- compaction backend 能安装一个有序 replacement history，而非只返回 text summary；
- pi-ai Codex API 对 V2 可复用 `onPayload` 发 trigger，但必须新增 raw output-item callback；V1 另需 unary compact method；
- unknown/foreign adapter 时 fail closed 或明确降级，不能把 encrypted content 当 user text。

前两点可沿用现有 assistant `replayState` 的 ownership 思路，但现有 replayState 只附着 assistant messages，见 `DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:4-20`。pi-ai 的 request mutation 已存在，见 `PI/dist/types.d.ts:68-76`；缺的是 stream body 中 raw compaction output 的公开回调，现有 parser 会跳过它，见 `PI/dist/api/openai-responses-shared.js:544-598`。

### 8.2 为什么不是改 agent loop

DSH 已把 automatic pressure/overflow 交给 compaction plugin events，见 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:775-828`；agent loop 文档明确要求扩展行为留在 plugins，见 `DSH/node_modules/@deepseek-ai/dsh-agent-loop/README.md:5-8`。因此 remote compaction 不需要把 Codex-specific branch 写进 agent-loop。

### 8.3 为什么不是只给 `BasicCompactionEngine.summarize` 多一个 HTTP client

该 hook 的 output 是 summary blocks，固定 transaction 的 output 是单 user checkpoint；Codex output 是 replacement history/native compaction item。证据分别为 `DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/summarizer.d.ts:28-46`、`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:548-560` 与 [current compact endpoint response#L66-L87](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/codex-api/src/endpoint/compact.rs#L66-L87)。只加 HTTP 不会补上 replay。

### 8.4 upstream 归属

- **DSH compaction/session/loop API：现有 seam 足以定义 backend、记录 durable transaction 与触发自动压缩。** 本研究没有证据支持先把 Codex-specific branch 写入这些运行时包。
- **DSH profile composition：当前明确缺 seam。** 最小可证请求是“bundle 可按 row id 给 shipped preset composition 贡献 overlay”，或等价的 route-aware backend registry；现状在 bundle layers 之后把 preset roots固定为 shipped root（`DSH/lib/profile-boot-DG5t9aNs.js:166-188`），所以插件无法自行完成 isolated backend wiring。
- **pi-ai Codex API：V2 最小缺口是 raw output-item callback；V1 另缺 unary compact operation。** `onPayload` 已足够注入 V2 trigger，不能笼统说 request seam 全部缺失。
- **`dsh-llm-pi-ai`：缺失把该 raw item 投影为 adapter-owned durable state并在后续 request 重放的 round trip。** 若不愿插件重写整个 adapter，应优先在 pi-ai 与该适配层补公开能力。

因此，这条 plugin-owned backend 路径的“最小 missing upstream seam”必须按假设回答：若只问**让自有 adapter+engine 能被 npm bundle 接入 DSH**，最小 DSH 缺口是 preset overlay/backend-selection seam；若要求**保留当前 PiAiAdapter 架构**，还必须同时补 pi-ai raw output 与 dsh-llm-pi-ai durable round trip。第 13 节推荐的 upstream-first Dual Checkpoint 设计不替换现有 Basic backend，因此不需要该 composition seam。

## 9. 依赖分类

分类定义：`in-process` 是同一 DSH Host 进程内可直接调用的代码/service；`local-substitutable` 是本机进程/文件/部署 wiring，可在不改变远端协议的情况下替换实现；`true external` 是插件无法在本机忠实替代的权威远端行为。

| 依赖 | 分类 | 证据与影响 |
|---|---|---|
| `ctx.compaction` / custom `CompactionEngine` | in-process | Public service/backend seam：`DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:61-75`。 |
| `Session.append`、surface replace、derived history | in-process | Public append/replace model：`DSH/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:178-212`、`DSH/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:381-410`。 |
| agent pressure/overflow events | in-process | Basic listeners：`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:775-828`。 |
| `ctx.llm` / `LlmAdapter` registry | in-process | Public adapter seam：`DSH/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:117-168`、`:227-234`。 |
| plugin `CodexAuthService` 与 access-token injection | in-process | Shared Host coordinator use：`PLUGIN/src/index.ts:79-114`、`PLUGIN/src/codex-auth-adapter.ts:193-215`。 |
| `@earendil-works/pi-ai` 0.82.1 | in-process | Installed library/version：`PI/package.json:1-4`；ordinary Codex provider：`PI/dist/providers/openai-codex.js:6-16`。 |
| DSH preset isolated compaction row | local-substitutable（仅用户/部署方） | Composition selects basic backend per preset：`DSH/config/agent-presets/code/agent.cordis.yml:133-162`；用户自建 preset 可换 wiring，但 npm bundle 无受支持 overlay/root seam，见 `DSH/lib/profile-boot-DG5t9aNs.js:166-188`。 |
| token meter / basic retention policy | local-substitutable | Backend-owned policy config：`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/lib/types/types.d.ts:7-39`；custom backend 可采用别的本地 policy。 |
| Codex CLI auth file/login command | local-substitutable（架构上被本项目 ADR 固定） | 项目选择官方 CLI 为唯一 login authority：`PLUGIN/docs/adr/0001-reuse-codex-cli-login-state.md:1-7`；remote compact wire 实质需要有效 credential，不需要在每次 compact 时启动 CLI。 |
| session persistence backend | local-substitutable | Session log 是 in-process，persistence 是 plugin concern：`DSH/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:1-4`。 |
| `https://chatgpt.com/backend-api/codex/responses/compact` | true external | ChatGPT base 与 endpoint 来自 tag source：`PLUGIN/docs/research/codex-remote-context-compaction.md:183-206`；服务端返回 replacement output。 |
| `https://chatgpt.com/backend-api/codex/responses` 的 `compaction_trigger` 解释 | true external | 客户端只发送空 trigger，见 [current v2 attempt#L69-L84](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/compact_remote_v2_attempt.rs#L69-L84)；生成算法不在客户端源码。 |
| opaque `encrypted_content` 的生成/解释 | true external | 客户端把它当 required String，见 [current models.rs#L1190-L1198](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/protocol/src/models.rs#L1190-L1198)。 |
| account/model entitlement、quota、服务端摘要算法 | true external | 公开客户端 payload 无算法参数；既有研究明确不可断言，见 `PLUGIN/docs/research/codex-remote-context-compaction.md:360-380`。 |
| OAuth refresh endpoint | true external | 插件设计固定调用 `https://auth.openai.com/oauth/token`，见 `PLUGIN/docs/design.md:53-65`。 |

## 10. Constraints

1. **Plugin-first**：不能 patch 已安装 DSH、deep import 私有 internals 或 monkey-patch prototype；本研究只接受公开 exports/service/event/session seams。公开 package exports 见 `DSH/node_modules/@deepseek-ai/dsh-compaction/package.json:16-34`、`DSH/node_modules/@deepseek-ai/dsh-compaction-basic/package.json:16-26`。
2. **一 context 一个 compaction provider**：`CompactionEngine` contract 要求一个 implementation 注册为 `ctx.compaction`，见 `DSH/node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts:67-75`；不能与 preset basic backend 并存竞争。
3. **不能损坏 DSH durability**：remote success 仍需完整 start/summary-or-equivalent checkpoint/end transaction、source seq 与 surface balance，见第 3.2 节证据。
4. **credential 只留在 Host；native payload 按敏感 Session 数据处理**：access/refresh token、Codex Login State 与请求头不得进入 Session、browser、日志或遥测。Opaque `encrypted_content` 不是 credential，但若作为 durable checkpoint 持久化，必须是无 credential 的 lossless JSON，并明确 browser projection、导出与体积策略。Host-only token 约束见 `PLUGIN/docs/design.md:198-208`。
5. **不能把 `encrypted_content` 当可读摘要**：公开类型只声明 opaque string；服务端编码/算法不可见，见 `PLUGIN/docs/research/codex-remote-context-compaction.md:360-380`。
6. **不能把 Long Context Mode 当 entitlement**：它只改 model metadata，见 `PLUGIN/src/codex-context.ts:28-40` 与 `PLUGIN/CONTEXT.md:71-73`。
7. **不能宣称 `main` 稳定契约**：项目已记录 Codex backend 不是 public versioned API，见 `PLUGIN/docs/design.md:198-212`；本文的 `main` 结论仅对 commit `b592a0bf…` 成立。

## 11. Open uncertainties

1. **ChatGPT account 上 v1/v2 的实际可用性与 model matrix**：公开客户端只给 provider-level capability上限；没有对本账户做 live probe。当前 capability code 见 [current provider.rs#L341-L353](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/model-provider/src/provider.rs#L341-L353)。
2. **最小必需请求头集合**：Codex CLI 发送 installation/session/thread/turn/routing 等 metadata；哪些是 compact endpoint 的 hard requirement、哪些仅 telemetry/stickiness，服务端未公开。既有研究能证明客户端发送这些头，但不能证明缺失时的服务端语义，见 `PLUGIN/docs/research/codex-remote-context-compaction.md:138-151`。
3. **`x-codex-turn-state` 的内容与生成规则**：客户端只证明同 turn 回送，服务端编码不可见，见 [current client.rs#L274-L295](https://github.com/openai/codex/blob/b592a0bfed439386fadc69327bd49eccb074cdc6/codex-rs/core/src/client.rs#L274-L295)。
4. **V1 output 中每种 retained item 的服务端选择算法**：客户端只过滤/安装 output；算法不在仓库，见 `PLUGIN/docs/research/codex-remote-context-compaction.md:240-257`、`:360-380`。
5. **composition seam 的具体形状仅影响 plugin-owned backend 备选方案**：当前源码已足以证明 bundle 无法 overlay shipped preset nested row（`DSH/lib/profile-boot-DG5t9aNs.js:166-188`）；推荐的 Dual Checkpoint 方案复用 shipped `BasicCompactionEngine`，不依赖该 Seam。
6. **native checkpoint 的 token/pressure 计价与 durable payload 上限**：只按可见文本计价会低估兼容 Codex 请求；按 opaque JSON 全量计价又会在 foreign provider 下高估。第 13 节给出保守候选，但固定算法与 byte cap 仍需 upstream owner 决定并以真实 fixture 校准。
7. **pi-ai 的后续演进**：安装版 0.82.1 与研究时最新发布版 0.84.3 都没有 compaction message/endpoint；0.84.3 证据见 [types.ts#L467-L526](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L467-L526)。未来版本仍可能变化，不能依赖未发布能力。
8. **初始 rollout policy**：当前 Codex v2 已 stable/default-on，但 DSH 的安全设计会额外生成 portable summary，带来第二次模型调用；应 default-on 还是 experimental opt-in 是产品决策，不是协议事实。

## 12. Evidence-backed decision boundary

- **采用**：保留 `BasicCompactionEngine` 作为唯一 transaction owner；复用其 session transaction、surface replace、tool-pair balance、trigger 与 manual durability。
- **不采用**：把 `BasicCompactionEngine.summarize` + 一次 `/responses/compact` fetch 描述为 faithful Codex remote compaction。
- **不采用**：在普通 checkpoint text/custom block 中偷藏 `encrypted_content`，或指望当前 PiAiAdapter 自动重放未知 block。
- **不采用**：插件内复制 `BasicCompactionEngine` 或完整 Codex Responses Adapter；该方案 Depth 低、Locality 差，并受 preset composition 阻塞。
- **推荐**：单独提议一个 upstream prepared-Adapter compaction Seam，让现有 Basic backend 生成 Dual Checkpoint。该方案不要求 preset overlay，也不把 Codex 分支写进 COMMON CALLER 或 agent loop。
- **范围边界**：本结论只授权研究文档；不授权修改 DSH core、pi-ai、全局安装、用户 profile 或 live account。

当前最准确的产品结论是：**plugin-only faithful implementation 不能成立；faithful 且可移植的实现需要一个很窄但真实的 upstream provider-native checkpoint Seam。**

## 13. 设计综合：三个方案与推荐 Interface

本节是基于前述 facts 的设计判断，不是已存在的 API。

### 13.1 建议先统一的领域语言

- **Portable Checkpoint**：DSH 产生的 provider-neutral 文本 checkpoint；切换 provider、卸载插件、未知 codec 或恢复失败时仍可继续。
- **Provider-native Checkpoint**：由 owning Adapter 持有语义的 canonical replacement history；payload 对 DSH opaque，只能在兼容环境中重放。
- **Dual Checkpoint**：同一个 DSH compaction transaction 同时持有 Portable Checkpoint 与可选 Provider-native Checkpoint；两者引用同一 shadowed range。
- **Compatibility Identity**：Adapter 生成并解释的非秘密标识，用于判断 model family、account、system/tools、codec generation 等是否仍可安全重放。

这些是候选术语；在讨论确认前不写入 `CONTEXT.md`。`Long Context Mode` 继续只表示容量/触发策略，不能作为 native capability 或 compatibility 的同义词。

### 13.2 Design A：plugin-only engine + full Codex Adapter

插件注册 sibling `CompactionEngine`、自己完成 range/transaction，并用完整自有 `LlmAdapter` 发送/重放 Codex ResponseItems。

- **优点**：无需等待 upstream；所有实验代码在一个仓库。
- **Depth**：表面上只有插件 Interface，实际要复制 Basic lifecycle、Pi serializer、SSE/WebSocket、tool/reasoning/image replay，隐藏不了复杂性。
- **Locality**：同一协议规则散落在插件、pi-ai wrapper、session checkpoint 与 custom engine。
- **Seam 问题**：当前 bundle 还不能替换 shipped preset isolated compaction row。
- **结论**：拒绝。第三方 Pi extension 能靠 `session_before_compact` + `before_provider_request` 完成类似 shim，但 DSH 没有等价 raw-payload/durable projection Seam；复制其 transport 不是 plugin-first。

### 13.3 Design B：Basic engine + prepared Adapter Dual Checkpoint（推荐）

保留 shipped `BasicCompactionEngine`。它在现有文本 summarization 之外，向当前 routed Adapter 保守询问一次 provider-native compaction；成功时把 opaque state 原子附着到同一个 replacement checkpoint，失败时保持现有 text-only 行为。

- **Module**：Provider-Native Compaction。
- **Interface/Seam**：`@deepseek-ai/dsh-llm` 的 registration-bound prepared call；能力由可调用操作本身表达，不增加 provider-name switch 或全局 capability registry。
- **Adapter**：Codex Adapter 隐藏 endpoint、认证、v1/v2、ResponseItem codec、response validation、账户/model compatibility 与 replay。
- **Depth**：一个小 Interface 隐藏 provider wire 与持久 replay 的全部复杂性。
- **Leverage**：所有已经安装 Basic backend 的 preset 自动获得能力协商与 fallback；COMMON CALLER 零改动。
- **Locality**：transaction 留在 compaction Module，Codex wire 留在 Codex/pi-ai Adapter，ownership filtering 留在 LLM Runtime。
- **代价**：安全语义要求同时保留 Portable Checkpoint，通常多一次 summarization 调用；durable payload、usage 与 pressure accounting 也需扩展。

### 13.4 Design C：provider-aware history virtualization

不生成并行文本摘要；把 native checkpoint 存在 surface 之外。兼容 Adapter 使用 native view，foreign Adapter 从 append-only log 重新展开被 shadow 的原始历史，再为目标 provider 生成新 checkpoint。

- **优点**：不支付双摘要调用；provider switching 时理论上可恢复完整原史而非文本投影。
- **Depth**：若完成，会形成很深的 multi-view history Module。
- **问题**：需要 provider-aware surface projection、variant checkpoint、re-expansion、切换时再压缩和多 variant durability；改变 DSH 当前“一个 canonical derived surface”的模型。
- **Leverage**：当前只有 Responses compaction 一个真实消费者，Interface 面远大于现阶段证据。
- **结论**：保留为未来方向；现在属于 speculative Seam。

| 方案 | Seam 放置 | Depth | Locality | Provider switching | 当前结论 |
|---|---|---:|---:|---|---|
| A. plugin-only full replacement | plugin engine + adapter | 低 | 低 | 需插件自建 | 拒绝 |
| B. prepared Adapter + Dual Checkpoint | LLM Adapter + existing Basic engine | 高 | 高 | 文本安全降级 | **推荐** |
| C. provider-aware virtualization | Session/surface projection | 潜在很高 | 中 | 可恢复原史 | 未来研究 |

### 13.5 推荐的最小公开 Interface

在 `@deepseek-ai/dsh-llm` 的既有 prepared-call Seam 上增加一个可选 operation；它与 model metadata、配置和最终 dispatch 绑定同一 Adapter generation：

```ts
export interface ProviderNativeCompactionInput {
  readonly messages: readonly Message[]
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly sessionId?: GenerateOptions['sessionId']
  readonly signal: AbortSignal
}

export interface ProviderNativeCompactionResult {
  /** Adapter-private durable format. Must be lossless JSON. */
  readonly kind: string
  readonly version: number
  readonly compatibility: string
  readonly state: JsonValue

  /** Estimated tokens this checkpoint will occupy when replayed. */
  readonly replayInputTokens: number
  readonly usage?: TokenUsage
}

export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  compactHistory?(
    input: ProviderNativeCompactionInput,
  ): Promise<ProviderNativeCompactionResult>
}
```

`JsonValue` 应在 `@deepseek-ai/dsh-llm` 内定义为 lossless JSON 递归类型；`sessionId` 复用 `GenerateOptions` 字段，不能反向 import `@deepseek-ai/dsh-session`，否则会破坏当前 `dsh-session → dsh-llm` 依赖方向。`ProviderNativeCheckpoint` 也由 `dsh-llm` 定义，再由 `dsh-compaction` 的 checkpoint source 引用。

`PreparedLlmCall` 暴露同样的 optional `compactHistory()`。Runtime 必须复用 `prepareCall()` 的 one-generation/one-shot 语义，并让 `stream()` 与 `compactHistory()` 共享同一个 dispatch guard：任一操作开始后，另一操作及重复调用都以 `INVALID_PREPARED_CALL` 失败。HMR、route replacement 或 Long Context Mode 更新不能让 capability 判断与 operation 跨 generation。

扩展 canonical checkpoint source，而不是伪装成 assistant replay 或普通内容块：

```ts
export interface ProviderNativeCheckpoint {
  readonly provider: string
  /** Provenance, not an unconditional exact-model replay lock. */
  readonly model: string
  readonly kind: string
  readonly version: number
  readonly compatibility: string
  readonly state: JsonValue
  readonly replayInputTokens: number
}

export interface CompactionCheckpointSource {
  readonly kind: 'plugin'
  readonly plugin: 'compact'
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
  readonly providerNative?: ProviderNativeCheckpoint
}
```

外部 Interface 不出现 `responses/compact`、`compaction_trigger`、`encrypted_content` 或 v1/v2 enum；这些都属于 Codex Adapter 的隐藏 Implementation。`model` 只记录 provenance；实际兼容性由 owning Adapter 根据 `compatibility` 判定，不能在 DSH core 中写死 exact-model equality。

### 13.6 transaction 与 fallback 不变量

1. Basic backend 继续独占选区、balanced tool pairs、durable lock、稳定性检查、strict shrink、surface replace、marker pairing 与 manual flush。
2. Portable 与 native 两条路径必须基于同一个 immutable selected span；提交前仍重检 surface generation。
3. Portable summary 成功是提交前提。native 成功但 portable 失败时，整次不安装；不得产生 route-locked remote-only checkpoint。
4. Adapter 不支持、HTTP/shape/codec/size 失败时，自动提交现有 text-only checkpoint；`AbortSignal` 原样中止，不把取消伪装成 fallback success。
5. remote response 完成不等于安装；只有进入现有同步 `compaction/summary` + replacement `user/message` commit body 后 state 才 durable。
6. sequencing 是隐藏 Implementation：首版可先 local 后 native，获得最简单的故障语义；以后可并行降低延迟，而不改变 Interface。
7. `compaction_trigger` 只存在于请求，绝不持久化；canonical item 顺序、未知字段和 opaque bytes 不得解析、截断或重写。
8. native payload 只能包含 replay 所需的无 credential JSON；token、refresh state、authorization/header 原文不得进入 Session 或 diagnostics。

### 13.7 replay、切换与恢复

- `LlmRuntime` 仿照现有 assistant `replayState` ownership：只有历史 provider 与目标 provider 均由同一个 Adapter instance 拥有时，才把 `providerNative` 交给 Adapter；foreign Adapter 收到剥离 native state 后的 Portable Checkpoint。Runtime 应使用 `dsh-llm` 自己定义的 envelope/type guard，不反向依赖 `dsh-compaction`。
- 同一 Adapter 内，Codex codec 再检查 version、Compatibility Identity、非秘密 account identity、model family 与当前 system/tools；未知或不兼容即 fail closed 到文本。
- 切走其他 provider 不修改 durable state；切回兼容 Codex 时可重新使用 native checkpoint。
- 重启、resume、fork 与多次 compaction 后，payload 必须 lossless round-trip；旧 checkpoint 出现在新 native compaction span 中时，owning Adapter 先展开旧 canonical history，再生成新 checkpoint。
- prepared operation 绑定 Adapter generation；HMR/route replacement 不得把旧 compatibility 与新 transport 混用。

### 13.8 token、usage、体积与 observability

Dual Checkpoint 不能只解决 replay 而忽略 pressure accounting：

- `replayInputTokens` 必须覆盖 retained native items + opaque artifact 的预计后续输入占用；若 native checkpoint 不比 shadowed span 小，应放弃 native state并保留文本。
- 对 owning provider，checkpoint price 至少取 `max(portableTextTokens, replayInputTokens)`；foreign provider 只需 portable price。若 Runtime 无法在 meter 层证明兼容，保守取 max 比低估安全，但可能提前触发后续压缩，需用真实 fixture 校准。
- `compaction/summary` 应新增不含 payload 的 native usage/diagnostic facts，使第二次调用不会从 usage accounting 消失：provider/model、kind/version、duration、usage、payload bytes、replay token estimate、结果/fallback 分类。
- durable state 必须有明确 byte cap；超限只能降级文本，不能截断 opaque payload。具体 cap 目前没有一手数据，应通过 live fixture 决定。
- 日志、错误、telemetry、settings 与普通 UI 禁止记录 canonical payload、`encrypted_content`、turn state 或 credential。Session/browser projection 是否发送 opaque state需沿用或收紧 DSH 对 assistant replay state 的既有策略，并做 payload-size 测试。

### 13.9 pi-ai 边界与外部验证证据

安装版 pi-ai 0.82.1 与发布版 0.84.3 都没有 compaction item/history 类型。理想 Locality 是由 pi-ai 的 Codex provider实现 compact + replay；但不能把设计建立在未承诺的 future support 上。上游 issue [earendil-works/pi#6492](https://github.com/earendil-works/pi/issues/6492) 因新贡献者策略被 automation 关闭，不能解释成 maintainer 对技术方案的接受或否决。

若 pi-ai 暂不提供，该 vertical slice 还需 `dsh-llm-pi-ai` 的窄 Adapter：在它已经完成 attachment hydration 与 pi Context conversion 的位置，把 native compact/restore 委托给 plugin-supplied Codex codec。不能 deep-import converter、patch private fetch 或复制普通 stream implementation。

第三方 [pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction/tree/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466) 是可行性证据而非依赖：它并行保存 portable summary 与 native replacement history，并验证了 ChatGPT Codex v2 的 resume/fork/model-switch continuity，见 [VALIDATION.md](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/VALIDATION.md)。其 held-out synthetic benchmark 中 native recall 为 78%，Pi 默认文本为 48%；但 native compaction output 为 4.58×、compaction cost 为 2.52×、后续 context 为 1.29×，且 allocation 高方差，见 [REPORT.md](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/product-defaults/REPORT.md#executive-result)。这支持“可能提升旧状态保真度”，不支持“同预算更高效”。

### 13.10 v1/v2 与 rollout 建议

- 外部 Interface 保持 protocol-agnostic。
- 当前 Codex `main` 已把 v2 标为 stable/default-on，且第三方 live test 覆盖 ChatGPT backend；若目标是 Codex parity，建议 v2 primary。
- v1 有公开 `/responses/compact` SDK 契约，适合作为实现 fallback/诊断路径；首版不要在一次 transaction 内无条件串行尝试 v2→v1→local，避免重复成本。按 unsupported/404 与 process-local circuit breaker 选择后续尝试即可。
- 鉴于 ChatGPT route 非公开 versioned contract、Dual Checkpoint 多一次调用、第三方 benchmark 显示明显成本/方差，建议首版 **experimental opt-in**。UI 不暴露 v1/v2，只暴露一个 plugin-owned native checkpoint policy；验证稳定后再讨论 default-on。
- Long Context Mode 只改变 pressure timing；它既不启用 native capability，也不进入 codec compatibility。

### 13.11 Interface 测试最低集

1. unsupported Adapter 只生成现有文本 checkpoint；event order 与 strict shrink 不变。
2. native success + portable success 原子持久化 Dual Checkpoint；native success + portable failure 不提交。
3. v2 缺 `response.completed`、零个/多个 compaction item、空 opaque content 均拒绝安装；v1 非 `response.compaction` 或非法 output 同理。
4. same Adapter/compatible codec 展开 native history；foreign Adapter、账户/model/codec 不兼容只看到文本。
5. restart/resume/fork/model-switch round trip 后 payload 等价且切回 Codex 可恢复。
6. consecutive compaction 能展开旧 native checkpoint，并安装新 replacement history。
7. HMR/route replacement 保持 prepared generation 原子性。
8. remote timeout/429/5xx/invalid JSON/oversize state 走文本 fallback；abort 不提交。
9. token pressure 同时覆盖 portable/native price，remote usage 不丢失。
10. 日志、RPC diagnostics 与 settings 不含 token、header、canonical payload 或 opaque 原文。
11. Long Context Mode on/off 只改变触发预算，不改变 compact request/replay contract。

### 13.12 待讨论的三个产品决策

1. 是否接受把最小 DSH / `dsh-llm-pi-ai` vertical slice 作为**单独 upstream scope**？若不接受，应停止而不是做 plugin shim。
2. 是否接受 Dual Checkpoint 的第二次模型调用，换取 provider switching、插件移除与 codec evolution 的安全语义？
3. 首版 rollout 采用 experimental opt-in，还是跟随 Codex CLI default-on？

