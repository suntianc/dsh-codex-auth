# OpenAI Codex 远程上下文压缩（Remote Context Compaction）实现研究

> 本文档全部基于一手资料：官方 `openai/codex` 仓库源码（Rust 实现 `codex-rs/`），
> 固定基线为 `rust-v0.147.0`（commit `be6e8eac029b183056b7e4402879f15d2c85f61b`），
> 并对照抓取的最新 `main`（commit `85fc4def358b7df21883e72ae8dda43a0f572f32`，2026-08-15）
> 标注差异。结论不可从源码判定处，均明确写为“不可断言”。
>
> GitHub 永久链接格式：`https://github.com/openai/codex/blob/<commit>/<path>#L<start>-L<end>`。

---

## 0. 术语与总览

Codex 把“压缩上下文历史”三条实现路径统一抽象为一次 *compaction 生命周期*，通过
`CompactionImplementation` 枚举区分：

| 实现 | 枚举值 | 说明 |
|------|--------|------|
| 本地压缩（local） | `Responses` | 向**普通 `/responses` 流式端点**发一段 `SUMMARIZATION_PROMPT`，把模型返回的摘要文本拼进新历史 |
| 远程压缩 v1 | `ResponsesCompact` | 调用**专用 `POST /responses/compact`**（unary，非流式），服务端直接返回整段新历史 |
| 远程压缩 v2 | `ResponsesCompactionV2` | 复用**普通 `/responses` 流式端点**，在输入末尾追加一个 `CompactionTrigger` item，从流里读回一个 `ResponseItem::Compaction` |

“远程”专指有独立服务端压缩能力的路径（v1 与 v2）；“本地”指客户端自己用一次普通
模型采样生成摘要。二者在“替换历史 / 进入 rollout / 触发语义”上共用同一套骨架，只有
“谁来生成摘要、从哪个端点拿结果”不同。

> 注意：`compact_model_fallback.rs:36-40` 把三者映射为遥测标签 `responses` /
> `responses_compact` / `responses_compaction_v2`，可作为枚举命名的旁证。

---

## 1. 触发条件（什么条件触发远程压缩）

触发分**手动**（`CompactionTrigger::Manual`）与**自动**（`Auto`），自动又分 phase
（`MidTurn` / `PreTurn`）与 reason（`ContextLimit` / `ModelDownshift` / `CompHashChanged`）。

### 1.1 手动触发

`/compact` 这类会话任务走 `CompactTask`。见
[`codex-rs/core/src/tasks/compact.rs#L28-L85`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/tasks/compact.rs#L28-L85)：

```rust
if ctx.config.features.enabled(Feature::TokenBudget) {
    crate::compact_token_budget::run_manual_compact_task(...)   // token-budget 路径
    return Ok(None);
}
let result = match ctx.provider.capabilities().remote_compaction {
    RemoteCompactionSupport::V2 if ctx.config.features.enabled(Feature::RemoteCompactionV2) =>
        crate::compact_remote_v2::run_remote_compact_task(...),     // 远程 v2
    RemoteCompactionSupport::V1 | RemoteCompactionSupport::V2 =>
        crate::compact_remote::run_remote_compact_task(...),        // 远程 v1
    RemoteCompactionSupport::Unsupported =>
        crate::compact::run_compact_task(...),                      // 本地
};
```

### 1.2 自动触发（触发点都在 `session/turn.rs`）

自动压缩的统一入口是 `run_auto_compact`（
[`codex-rs/core/src/session/turn.rs#L1146-L1226`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L1146-L1226)），
它同样先看 `Feature::TokenBudget`，再按 `remote_compaction` 能力分派。三个调用点：

1. **Mid-turn / `ContextLimit`** —— 采样后 `token_status.token_limit_reached` 且
   `needs_follow_up`（模型还要继续），并满足 `take_new_context_window_request() || token_limit_reached`
   时滚动触发。见
   [`codex-rs/core/src/session/turn.rs#L422-L462`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L422-L462)。
   这是 `InitialContextInjection::BeforeLastUserMessage`（压缩摘要必须留在末尾，初始上下文插到最后一个真实用户消息之前）。

2. **Pre-turn / `ContextLimit`** —— `run_pre_sampling_compact` 在每轮采样前检查
   `context_window_token_status(...).token_limit_reached`，命中则先压一轮再继续。见
   [`codex-rs/core/src/session/turn.rs#L980-L1008`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L980-L1008)。

3. **Pre-turn / `CompHashChanged` 与 `ModelDownshift`** —— `maybe_run_previous_model_inline_compact`
   在切换模型时：若 compaction-compatibility hash 变化（`comp_hash_changed`，两边都有值且不同），
   或切到了更小上下文窗口模型且旧模型 token 已超限，则触发。见
   [`codex-rs/core/src/session/turn.rs#L1048-L1138`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L1048-L1138)。

> “token 限制”的判定依据分两类（`model_auto_compact_token_limit_scope`）：
> `Total`（`active_context_tokens > auto_compact_token_limit || >= new_context_window`）或
> `BodyAfterPrefix`（仅 `>= new_context_window`）。见
> [`turn.rs#L1100-L1112`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L1100-L1112)。

### 1.3 能力门槛（provider 支持与否）

`remote_compaction` 是 provider 级能力上限：
[`codex-rs/model-provider/src/provider.rs#L299-L312`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider/src/provider.rs#L299-L312)：

```rust
let remote_compaction = if self.info.is_openai()
    || is_azure_responses_provider(&self.info.name, self.info.base_url.as_deref())
{ RemoteCompactionSupport::V2 } else { RemoteCompactionSupport::Unsupported };
```

枚举语义见
[`provider.rs#L30-L39`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider/src/provider.rs#L30-L39)：
`V1` 只支持专用 `/responses/compact`；`V2` 额外支持 `compaction_trigger` item。Amazon Bedrock 映射为 `V1`
（[`amazon_bedrock/mod.rs#L130`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider/src/amazon_bedrock/mod.rs#L130)）。

综上：**触发远程压缩的先决条件是（a）命中上面某个 trigger 点，且（b）当前 provider 的
`remote_compaction != Unsupported`，且（c）`Feature::TokenBudget` 未启用、`Feature::RemoteCompactionV2`
（仅在要启用 v2 语义时）为真。否则回落到本地压缩或 token-budget 压缩。**

---

## 2. 客户端调用的 endpoint、请求与响应结构

### 2.1 v1 专用端点 `POST /responses/compact`（unary）

端点常量与超时倍数：
[`codex-rs/core/src/client.rs#L160-L164`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/client.rs#L160-L164)：

```rust
const RESPONSES_ENDPOINT: &str = "/responses";
const RESPONSES_COMPACT_ENDPOINT: &str = "/responses/compact";
const COMPACT_REQUEST_TIMEOUT_IDLE_MULTIPLIER: u32 = 4;  // 注释明确：unary，超时覆盖整次响应
```

`compact_conversation_history` 的入口与方法注释（“unary、非流式、返回新的 `ResponseItem` 列表”）：
[`codex-rs/core/src/client.rs#L543-L560`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/client.rs#L543-L560)。

**请求体**由 `CompactionInput` 序列化，字段为
[`codex-rs/codex-api/src/common.rs#L26-L44`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/common.rs#L26-L44)：

```rust
pub struct CompactionInput<'a> {
    pub model: &'a str,
    pub input: &'a [ResponseItem],       // 被压缩的整段历史
    pub instructions: &'a str,           // 空串则跳过序列化
    pub tools: Option<ResponsesApiTools>,// 缺省跳过
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,    // 缺省跳过
    pub service_tier: Option<&'a str>,   // 缺省跳过
    pub prompt_cache_key: Option<&'a str>,// 缺省跳过
    pub text: Option<TextControls>,      // 缺省跳过
}
```

请求的路由/请求头构建见
[`client.rs#L578-L649`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/client.rs#L578-L649)：
携带 `x-codex-installation-id`、`x-codex-turn-state`（回填用，见下）、originator、compatibility、
session/thread 头、attestation、`x-openai-internal-codex-responses-lite` 等。

**响应体**是固定的 `{"output": [...]}` JSON，客户端反序列化为
[`codex-rs/codex-api/src/endpoint/compact.rs#L85-L88`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/endpoint/compact.rs#L85-L88)：

```rust
struct CompactHistoryResponse { output: Vec<ResponseItem> }
```

并**从响应头 `x-codex-turn-state` 回填 `turn_state`**（
[`endpoint/compact.rs#L39-L82`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/endpoint/compact.rs#L39-L82)）。

### 2.2 v2 复用 `/responses` 流式端点

v2 **不发到 `/responses/compact`**，而是用 `ModelClientSession::stream(...)` 走普通 `/responses`
流，并在输入末尾 `push(ResponseItem::CompactionTrigger {})`：
[`codex-rs/core/src/compact_remote_v2_attempt.rs#L66-L79`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2_attempt.rs#L66-L79)
与
[`compact_remote_v2.rs#L335-L383`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L335-L383)。

`collect_compaction_output` 强制要求**恰好一个** `ResponseItem::Compaction`，否则
`CodexErr::Fatal`；且必须收到 `response.completed`（
[`compact_remote_v2.rs#L385-L442`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L385-L442)）。
v2 的重试上限固定为 `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES = 2`（
[`compact_remote_v2.rs#L60-L64`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L60-L64)）。

### 2.3 相关协议 item 类型（请求/响应里的特殊 item）

- `ResponseItem::Compaction { id, encrypted_content }` —— 压缩产物，带
  `#[serde(alias = "compaction_summary")]`，`encrypted_content` 是服务端摘要（对客户端不透明）。见
  [`codex-rs/protocol/src/models.rs#L1020-L1029`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/models.rs#L1020-L1029)。
- `ResponseItem::CompactionTrigger {}` —— “请求控制项，不是持久化的响应项”。见
  [`models.rs#L1030-L1031`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/models.rs#L1030-L1031)。
- `ResponseItem::ContextCompaction { id, encrypted_content? }` —— UI/路由层面的压缩标记项。见
  [`models.rs#L1032-L1042`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/models.rs#L1032-L1042)。

---

## 3. ChatGPT 登录与 API-key 路由是否不同

**是，二者落到不同 host 和不同 base path；并且 `service_tier` 传播也有区别。**

### 3.1 base URL 路由

`Provider::url_for_path` 只是 `base_url + "/" + path` 拼接（
[`codex-rs/codex-api/src/provider.rs#L52-L75`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/provider.rs#L52-L75)），
真正的 host 差异来自 `ModelProviderInfo::to_api_provider(auth_mode)`（
[`codex-rs/model-provider-info/src/lib.rs#L243-L261`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider-info/src/lib.rs#L243-L261)）：

```rust
let default_base_url = if matches!(auth_mode,
    Some(AuthMode::Chatgpt | AuthMode::ChatgptAuthTokens | AuthMode::Headers
       | AuthMode::AgentIdentity | AuthMode::PersonalAccessToken))
{ CHATGPT_CODEX_BASE_URL }
else { "https://api.openai.com/v1" };
```

而
[`CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider-info/src/lib.rs#L37)。

因此：

- **ChatGPT 登录族**（`Chatgpt` / `ChatgptAuthTokens` / `Headers` / `AgentIdentity` /
  `PersonalAccessToken`）→ 压缩端点 = **`https://chatgpt.com/backend-api/codex/responses/compact`**。
- **`ApiKey` 及 `BedrockApiKey`**（走 `else` 分支或 Bedrock 自己的 base）→ 压缩端点 =
  **`https://api.openai.com/v1/responses/compact`**。

> `AuthMode` 枚举与 `uses_codex_backend`/`is_api_key_auth` 判定见
> [`codex-rs/protocol/src/auth.rs#L9-L53`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/auth.rs#L9-L53)。

### 3.2 `service_tier` 传播差异

`compact_remote_request.rs` 在构造 `CompactConversationRequestSettings` 时**对 API-key 认证显式
置空 `service_tier`**：

```rust
service_tier: if sess.services.auth_manager.auth_mode() == Some(AuthMode::ApiKey) { None }
             else { turn_context.config.service_tier.clone() },
```

见
[`codex-rs/core/src/compact_remote_request.rs#L84-L92`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_request.rs#L84-L92)。
因此：ChatGPT 登录会把用户配置的 service tier 透传；API-key 路由则不带 service_tier。

---

## 4. 返回的压缩历史如何替换 / 重建本地上下文

三次实现最终都收敛到 `Session::replace_compacted_history`（
[`codex-rs/core/src/session/mod.rs#L3238-L3284`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/mod.rs#L3238-L3284)）：

1. 为缺失的 item 分配 ID（`assign_missing_response_item_ids`），保证 live 与持久化历史一致；
2. 构造 `CompactedItem { message, replacement_history, window_number, window_ids }`；
3. `state.replace_history(items, reference_context_item)` —— **整段替换** live 历史；
4. 若压缩点给了 world-state baseline，则落一份 `WorldStateItem::full`；
5. `persist_rollout_items(&[RolloutItem::Compacted(compacted_item)])` + 可选 `WorldState`/`TurnContext`
   持久化；
6. 排队一个 `SessionStartSource::Compact` 的 session-start 钩子。

### 4.1 压缩输出在进入 `replace_compacted_history` 前如何被“清理/重建”

远程 v1 走 `process_compacted_history`（
[`codex-rs/core/src/compact_remote.rs#L304-L323`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote.rs#L304-L323)）：

- 对服务端返回的 history 过一遍 `should_keep_compacted_history_item`（
  [`compact_remote.rs#L325-L368`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote.rs#L325-L368)）：
  **丢弃 `developer` 消息**（可能过期/重复）、丢弃非 user-content 的 `user` 包装；
  **保留** `assistant`、`AgentMessage`、`Compaction`/`ContextCompaction`；
  **丢弃** reasoning、工具调用/输出、web/search/image 等瞬态项。
- 再把 `initial_context` 插到“最后一个真实用户消息 / 摘要之前”（
  `insert_initial_context_before_last_real_user_or_summary`，
  [`compact.rs#L549-L614`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact.rs#L549-L614)）。

远程 v2 先把请求输入按 `is_retained_for_remote_compaction_v2` 保留下 user/developer/system/
非 FINAL_ANSWER 的 AgentMessage，再按 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` 截断，最后把读回的
`ResponseItem::Compaction` 追加为末尾条目（`build_v2_compacted_history`，
[`compact_remote_v2.rs#L444-L491`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L444-L491)）。

> `initial_context_injection` 语义（
> [`compact.rs#L57-L72`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact.rs#L57-L72)）：
> pre-turn/manual 压缩用 `DoNotInject`（下一个正常 turn 全量重注入初始上下文）；mid-turn 用
> `BeforeLastUserMessage`（模型训练上要求压缩摘要留在历史末尾，故把初始上下文插到最后一个真实用户消息之上）。

本地 `Responses` 路径则是在客户端用一段 `SUMMARIZATION_PROMPT`（
`codex-rs/prompts/templates/compact/prompt.md`）发起一次普通采样，把 `get_last_assistant_message_from_turn`
作为摘要，用 `SUMMARY_PREFIX`（`codex-rs/prompts/templates/compact/summary_prefix.md`）拼接，
再 `build_compacted_history`（最多保留 20k token 的用户消息 + 摘要）重构历史。见
[`compact.rs#L342-L387`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact.rs#L342-L387)。

> 压缩标记进入会话的边界由 `Session::replace_compacted_history` 内部 `state.replace_history` 完成，
> 但“语义边界”注释明确写：**install 是压缩端点输出变为 live 历史的边界，应和后续推理请求分开**。
> 见
> [`compact_remote.rs#L277-L285`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote.rs#L277-L285)。

---

## 5. compaction item / event 如何进入 rollout / session

### 5.1 UI/item 层面（session）

每次压缩开始先发一个 `TurnItem::ContextCompaction(ContextCompactionItem::new())` 并
`emit_turn_item_started`，结束时 `emit_turn_item_completed`。item id 即压缩 id
（`ContextCompactionItem.id` 由 `Uuid::now_v7` 生成），作为压缩生命周期与 trace 的同一 join key。
见
[`compact_remote.rs#L200-L213`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote.rs#L200-L213)、
[`protocol/src/items.rs#L434-L453`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/items.rs#L434-L453)。

持久化层面，压缩以一个 `RolloutItem::Compacted(CompactedItem)` 写入 rollout（见第 4 节），
`CompactedItem` 结构见
[`codex-rs/protocol/src/protocol.rs#L3243-L3260`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/protocol.rs#L3243-L3260)：
包含 `message`、`replacement_history`、`window_number` 和三个 UUIDv7 window id
（`first_window_id`/`previous_window_id`/`window_id`）。

### 5.2 rollout-trace（rollout 血缘图）层面

远程压缩在 `codex-rs/rollout-trace` 里有一整套独立生命周期（区别于普通 sampling）：

- 事件原语（`raw_event.rs#L183-L206`）：`CompactionRequestStarted` /
  `CompactionRequestCompleted` / `CompactionRequestFailed` / `CompactionInstalled`。
- Hot-path 记录器 `CompactionTraceContext`（
  [`codex-rs/rollout-trace/src/compaction.rs#L28-L172`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout-trace/src/compaction.rs#L28-L172)）：
  `start_attempt` 记录**精确的 compact 端点 payload**；`record_installed` 写入
  `RawPayloadKind::CompactionCheckpoint`（`{ input_history, replacement_history }`）。
- reducer（`reducer/compaction.rs`）把 raw 事件折叠成 `Compaction { compaction_id, thread_id,
  codex_turn_id, installed_at_unix_ms, marker_item_id, request_ids, input_item_ids,
  replacement_item_ids }` 与 `CompactionRequest`。重点：**request 完成只记账、不改会话**，只有
  单独的 `CompactionInstalled` 事件才真正替换会话图。
  见
  [`codex-rs/rollout-trace/src/reducer/compaction.rs#L78-L171`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout-trace/src/reducer/compaction.rs#L78-L171)。
- 数据模型 `Compaction` / `CompactionRequest` 见
  [`codex-rs/rollout-trace/src/model/runtime.rs#L71-L107`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout-trace/src/model/runtime.rs#L71-L107)；
  会话 item 的 `ProducerRef::Compaction { compaction_id }` 见
  [`model/conversation.rs#L152`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout-trace/src/model/conversation.rs#L152)。

> 归纳：compaction item 以 `TurnItem::ContextCompaction` 走会话事件流；以 `RolloutItem::Compacted`
> 走持久化 rollout；在 rollout-trace 血缘模型里对应 `Compaction` 边界 + `CompactionRequest`
> 尝试 + `ProducerRef::Compaction`，三者用同一 `compaction_id` 关联。

---

## 6. 与 local compaction 的分工与 fallback / error 语义

### 6.1 分工

| 维度 | 远程 v1 (`ResponsesCompact`) | 远程 v2 (`ResponsesCompactionV2`) | 本地 (`Responses`) |
|------|------|------|------|
| 触发 | provider 支持 remote compaction | provider 支持 v2 且 feature 开启 | 其余（`Unsupported` 等） |
| endpoint | 专用 unary `/responses/compact` | 普通流式 `/responses` + `CompactionTrigger` | 普通流式 `/responses` + `SUMMARIZATION_PROMPT` |
| 摘要由谁生成 | **服务端** | **服务端**（以 `Compaction` item 返回，客户端不透明） | **客户端**（本地一次采样） |
| rollout-trace | 有完整生命周期 | 有完整生命周期 | 明确**不上 trace**（reducer 尚无本地压缩生命周期，`InferenceTraceContext::disabled()`） |

本地压缩不上 trace 的注释见
[`compact.rs#L707-L710`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact.rs#L707-L710)。

### 6.2 fallback / error 语义

- **model-downshift / comp-hash 触发的远程压缩失败 → 回退当前模型再试一次**：
  `run_remote_compact_task_inner_impl` 里，第一次 attempt 失败后若 `should_retry_with_current_model`
  为真且有 `fallback_step_context`，就用当前模型重试。
  [`compact_remote.rs#L223-L262`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote.rs#L223-L262)，
  [`compact_remote_v2.rs#L237-L276`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L237-L276)。
- 是否可重试当前模型的判据 `should_retry_with_current_model`（
  [`compact_model_fallback.rs#L8-L20`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_model_fallback.rs#L8-L20)）：
  `InvalidRequest` / `UnexpectedStatus` / `ContextWindowExceeded` / `UsageLimitReached` /
  `ServerOverloaded` / `InternalServerError` / `RetryLimit`。
- **流式重试上限**：v2 固定 2 次传输层重试（`MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES`），走
  `handle_retryable_response_stream_error`；v1 端点的 `CompactClient` 自身带 provider retry 配置。
- **本地 `Responses` 路径的错误分支**（
  [`compact.rs#L286-L339`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact.rs#L286-L339)）：
  `Interrupted`/`TurnAborted` 直接中止；`SessionBudgetExceeded` 上报并退出；
  `ContextWindowExceeded` 时**从头删最旧一条历史再循环**（保留前缀缓存），删到只剩一条仍超则失败；
  其余错误按 `stream_max_retries` 退避重试。
- **v2 输出合法性**：必须恰有一个 `Compaction` item 且收到 `response.completed`，否则 `Fatal`/`Stream`
  错误（`compact_remote_v2.rs#L419-L429`）。
- 三者统一在结束时发 `CompactionAnalyticsAttempt::track`（含 `CompactionStatus::Completed/
  Interrupted/Failed`），见 `compact.rs#L390-L478`。

---

## 7. 服务端摘要算法 —— 源码看不到、不可断言的部分

以下事实**无法从公开客户端源码判定**，属于服务端私有实现，不能据此断言：

1. **`ResponseItem::Compaction.encrypted_content` 的具体内容与加密/编码**：客户端只把
   `encrypted_content` 当作不透明字符串回填给后续请求；它是否真“加密”、密钥如何协商、
   字段语义均不可断言。
   [`models.rs#L1020-L1029`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/protocol/src/models.rs#L1020-L1029)。
2. **`/responses/compact` 服务端实际的摘要/重建算法**：请求体里只有 `model/input/instructions/...`
   等字段，未携带任何“如何摘要”的参数；`RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` 的注释明确写
   “mirror 当前 `/responses/compact` 保留消息默认值，**服务端路径仍是参考实现**”
   （[`compact_remote_v2.rs#L58-L61`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/compact_remote_v2.rs#L58-L61)），
   说明服务端如何裁剪/生成 `output` 不可见。
3. **`CompactionTrigger` 在服务端如何被触发/解释**：客户端只追加一个空 `{}` item，服务端据此
   生成的摘要逻辑完全在服务端。
4. **服务端是否使用 `prompt_cache_key` / `instructions` / `service_tier` 之外的隐式状态**：
   客户端透传了这些可选字段，但服务端如何消费、是否另有账号级/模型级压缩策略，源码看不到。
5. **摘要的 token/窗口计算精确公式**：客户端只有 `approx_token_count` 估算（本地）和 64k 预算
   常数（v2 客户端侧），服务端权威算法不可见。
6. **`x-codex-turn-state` 回填的语义**：客户端知道从响应头读回并回填，但该状态服务端如何生成、
   编码什么，不可断言。

---

## 8. 与当前源码（最新 `main`，commit `85fc4def…`）的差异

对照基线 `be6e8eac…` 与抓取的 `main`，涉及压缩的文件 diff 如下（`git diff --stat`）：

| 文件 | 变化 |
|------|------|
| `codex-rs/core/src/compact_remote_v2.rs` | +242/−54，**最大变化** |
| `codex-rs/core/src/compact.rs` | +73/−46 |
| `codex-rs/core/src/compact_remote.rs` | +57/−11 |
| `codex-rs/core/src/client.rs` | +53/−7 |
| `codex-rs/model-provider-info/src/lib.rs` | +33/−5 |
| `codex-rs/core/src/compact_remote_v2_attempt.rs` | +10/−3 |
| `codex-rs/core/src/compact_remote_request.rs` | +2/−2 |
| `codex-rs/model-provider/src/provider.rs` | −1（仅测试字段） |
| `tasks/compact.rs`、`compact_token_budget.rs`、`compact_model_fallback.rs`、`codex-api`、`rollout-trace` | **无变化** |

关键差异（都是“增量增强”，不是架构重写）：

1. **`ResponseItemEnvelope` + `CodexHarnessMetadata` 贯穿压缩历史**：当前 `main` 把压缩路径中的
   历史项从裸 `ResponseItem` 改为 `ResponseItemEnvelope { item, metadata }`，以携带
   `client_authored` 标记。`build_compacted_history`、`insert_initial_context_before_last_real_user_or_summary`
   等签名都改为 envelope。
2. **新增 `Feature::RetainClientDeveloperMessages`**：`build_v2_compacted_history` 现在接收
   `sess.enabled(RetainClientDeveloperMessages)`，允许保留客户端自己写的 `developer` 消息
   （`is_client_authored_developer_message`），否则仍按旧逻辑丢弃。`v2_history_item_groups`、
   `truncate_retained_messages_for_remote_compaction` 也做了相应拆分处理。
3. **`x-codex-routing-hint` 请求头**：`client.rs` 新增 `X_CODEX_ROUTING_HINT_HEADER =
   "x-codex-routing-hint"` 与 `build_routing_hint_header(...)`，在 OpenAI + Codex-backend 认证下
   附带 `model=...;tier=...` 路由提示（普通 `/responses` 与压缩请求共用）。
4. **`store: false`**：`build_responses_request` 的 `store` 字段由
   `provider.is_azure_responses_endpoint()` 改为硬编码 `false`（provider 参数随之从该方法移除）。
5. **`model-provider-info`/`provider.rs` 变化与压缩无关**：新增 “Amazon Bedrock Runtime” provider
   及 Bedrock 相关 model id/merge 逻辑；`provider.rs` 的 −1 只是测试 fixture 字段删除。
6. **`compact_remote.rs` 的 v1 路径也改用 envelope + `RetainClientDeveloperMessages`** 等同样增强。

**因此：本文第 1–7 节的基线结论（触发条件、endpoint `POST /responses/compact` 与
`/responses` + `CompactionTrigger`、请求/响应结构、ChatGPT vs API-key 路由、替换历史、
rollout 生命周期、fallback 语义）在最新 `main` 上仍然成立**；差异集中在“客户端作者的
developer 消息是否保留”这一可选 feature、以及新增 routing-hint 头和 `store:false` 这些增量上。

---

## 附：本仓库相关事实（非本次证据链，仅作背景）

本仓库已在 `docs/design.md` 明确：Codex 后端非公开版本化 API 契约；远端能力端点固定于
`https://chatgpt.com/backend-api/codex` 下；请求契约以 `rust-v0.147.0` commit
`be6e8eac029b183056b7e4402879f15d2c85f61b` 为基线。本研究的点对点 permalink 均锚定该 commit，
另有与最新 `main` 的对照（第 8 节）。
