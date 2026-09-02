# dsh-codex-auth

[![npm version](https://img.shields.io/npm/v/dsh-codex-auth.svg)](https://www.npmjs.com/package/dsh-codex-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

当前 npm 版本：**v0.3.2**

这是一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Codex 能力包**。它复用官方 **Codex CLI** 维护的 ChatGPT 登录态
（`~/.codex/auth.json`，或 `$CODEX_HOME/auth.json`），同时提供：

- `openai-codex` LLM 路由；
- 接入 DSH 内置 `web_search` 工具的全局 Codex 搜索提供方；
- 通过 `generate_image` 实现持久图片生成与编辑，并提供供模型使用的 `list_images` 目录；
- 稳健的 Codex 周用量状态；
- 一个原生 **GPT Auth** 设置分区，内含「登录」「LLM 上下文」「网页搜索」「图片创作」
  四张卡片；搜索与图片的详细设置可收起为紧凑卡片。

> **⚠️ 非官方通道——仅限个人开发。** 私有、受账户权限控制的
> `chatgpt.com/backend-api` 未获官方支持、可随时撤销，也可能在没有通知的情况下被限流
> 或变更。请勿依赖它承载生产任务。

## 功能

### 共享 Codex 登录态

- LLM、搜索与图片操作共用一个仅运行于 Host 的认证协调器。
- 通过绑定文件版本的认证快照、短时内存缓存解析凭证，并在到期前主动刷新。
- 进程内合并并发刷新；OAuth 网络请求前后各使用一段短跨进程锁，且只有账户与
  refresh token 谱系仍和决策快照一致时才写入响应。
- 可启动官方 `codex login` 浏览器登录或设备码登录流程。
- 设置页显示连接状态，以及尽力获取的周剩余额度和重置时间。固定的
  `/backend-api/wham/usage` 探测有 10 秒 Host 截止时间，并按窗口时长识别七天窗口。
- 插件自有、仅允许 loopback 的 `/codex-auth` Connection RPC 不会向浏览器发送任何 token 值。

### GPT-5.6 长上下文

GPT Auth 设置在登录卡片与能力卡片之间提供实时生效、默认关闭的 **1M 上下文**开关。
它会把 `gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` 向 DSH 报告的
上下文窗口从保守的 272,000 Token 提升到 1,000,000 Token。DSH 会据此计算 Token
压力和压缩时机；插件不会在请求里发送用于和后端协商容量的参数。超过 272K 的请求可能
更快消耗账户配额，后端是否支持仍取决于账户，而且启用开关不会展开 DSH 已经压缩的历史。

### 实验性 Dual Checkpoint 压缩 Adapter

包额外导出 `dsh-codex-auth/compaction`，仅供用户或部署者在**自定义 Agent preset**
中显式选择。`CodexCompactionEngine` 继承 DSH 的 `BasicCompactionEngine`，并包装手动、
step pressure 与 provider 已确认的 context-overflow 入口。每条路径都会先完成 Basic 原有、
provider-neutral 的 Portable 摘要；Host 随后只在内存中捕获该调用最终且不含 marker 的
Codex payload 与已经解析好的登录态，再发送一次末尾带临时 `compaction_trigger` 的独立
Responses v2 请求。若得到有效 opaque 结果，就把它追加在 Portable 摘要旁，由 Basic 的
同一个继承事务原子提交 **Dual Checkpoint**。选区、pruning、tool pair 平衡、重试上限、
持久 marker、surface replacement 与取消语义仍全部由 Basic 拥有。

Portable 成功永远先发生。路由或模型不一致、前缀为空或含图片、payload 不受支持、超时、
限流、HTTP/协议错误、状态过大或保守 shrink 预检失败时，都会只提交已经有效的 Portable
Checkpoint；Portable 失败则不提交 checkpoint。Native 请求不会重试。进程局部、按
account/model/endpoint/codec 隔离的 circuit breaker 会在五分钟内三次 transient 失败后
打开十分钟，在 protocol 或最终 payload shape 不受支持时打开一小时，并按设有上限的
HTTP 429 `Retry-After` 打开；half-open 只允许一个探测。HTTP 401/403、oversize-state 与
strict-shrink fallback 都不计数。它不会禁用普通推理或 Portable 压缩。插件卸载会中止活跃
Native 工作，并释放请求局部的 credential、payload、marker、canonical item 与 continuation。

Debug 诊断只包含 compaction ID、trigger、codec generation、model、eligibility/status/fallback
class、breaker state、耗时、item/byte 数、回放估算与 usage 是否可用；认证被拒绝时会提示执行
`codex login`。诊断绝不会包含 prompt、tool、header、token、turn state、canonical item、
encrypted content 或 provider 报告的 Token 数值。Native usage 数值可以作为诊断 metadata
保存在敏感 checkpoint 内，但 rc.2 的聚合 Token 记账仍只使用 Portable 摘要调用。

一次**内联自动** Native 压缩成功后，provider 响应中非空的 `x-codex-turn-state` 会成为
进程局部的 **Codex Turn Continuation**。只读 `llm/stream` waterfall 会在 Runtime 克隆前
观察 Agent-loop 原始请求；continuation 只会发送给 session、route、model、Codex account
与 Adapter generation 都相同的下一次请求。它在 60 秒后过期，并在首个不匹配的 eligible
请求、取消/错误、route replacement 或插件卸载时清除。Portable 摘要、session-title/辅助
调用、直接 maintenance、`compactRegion()` 与手动 `/compact` 都不会消费或 arm 它；它也
绝不会进入 Session event、checkpoint、UI state、日志、错误或 telemetry。

Native 生成仍只支持从当前 surface 头部开始、且 Portable 调用使用同一个精确
`openai-codex` 模型的前缀；显式 region 与选区内含图片的压缩仍只产生 Portable
Checkpoint，选定前缀之后的图片和其他消息继续留在 DSH tail。canonical 纯文本 user group
按从新到旧顺序在版本化的 64,000 Token JSON 预算内保留，边界处最多保留一个 Unicode-safe
文本前缀。回放估算对 opaque 内容单独采用固定 Codex 规则：base64 解码长度减去 650-byte
envelope allowance；该值不冒充 DSH 的 provider-neutral pressure price。完整 custom block
上限为 2 MiB，最终仍由 Basic 执行权威 strict-shrink 校验。额外 v2 请求会增加延迟并消耗
Codex 配额；其 opaque 状态不含 credential，但仍是敏感会话数据，而且 rc.2 会在 summary
event 与 replacement message 中各保存一份。

#### 启用并使用 Dual Checkpoint 压缩

正常安装 Codex 能力包不会启用这个 Adapter。`cordis.patch.yml` 与 DSH 内置 preset
仍然使用 stock Basic 压缩。请通过一个完整、由用户维护的自定义 preset 显式启用：

1. 把本包安装到实际运行 DSH 的 profile（以下示例使用 `web`）。
2. 将 DSH 的完整 Standard preset 复制为新的用户 preset。请选用新的 `PRESET_ID`；以下命令
   会拒绝覆盖已有目录：

   ```sh
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   DSH_ROOT="$(dirname "$(dirname "$(realpath "$(command -v dsh)")")")"
   PRESET_ID=codex-dual
   PRESET_DIR="$DSH_HOME/.agent-presets/$PRESET_ID"

   test ! -e "$PRESET_DIR"
   mkdir -p "$DSH_HOME/.agent-presets"
   cp -R "$DSH_ROOT/config/agent-presets/standard" "$PRESET_DIR"
   ```

3. 在 `$PRESET_DIR/preset.yml` 中为副本设置独立的 `name` 与 `description`。
4. 在 `$PRESET_DIR/agent.cordis.yml` 中，用下列文件里的完整 `- id: compaction` group
   **替换而不是追加**原有 group：

   ```text
   $DSH_HOME/profiles/web/node_modules/dsh-codex-auth/
   └── examples/agent-presets/codex-portable/agent.cordis.yml
   ```

   只复制示例中的 `compaction` group。该示例刻意不含 persona 或工具，不能替代刚复制的
   Standard preset。最终 group 必须只有一个带 `auto: true` 的
   `dsh-codex-auth/compaction` 行，并保留 `@deepseek-ai/dsh-command-compact` 与
   `@deepseek-ai/dsh-compaction-tool-result-pruner`，且不能包含
   `@deepseek-ai/dsh-compaction-basic`；`ctx.compaction` 只能有一个所有者。
5. 重启 DSH，新建会话并选择该自定义 preset，再选择 `openai-codex` 模型。需要 Native
   回放时，请保持 provider、精确模型、账户以及显式 reasoning 设置不变。

配置 `auto: true` 后，自定义 engine 会自动处理上下文压力压缩和 provider 确认的 context
overflow；`/compact` 则手动调用同一个 engine。所有入口仍然 Portable-first：符合条件的
Codex 请求会增加 Native 同级表示，任何不兼容或 Native 失败都会保留有效 Portable
Checkpoint。即使下一次兼容 provider 请求实际回放 Native，stock conversation 视图仍会
刻意显示 Portable 文本。

该实验性导出只支持 DSH / Basic compaction `0.1.1-rc.2` 与 pi-ai `0.82.1`；
在其他版本组合上挂载会给出可操作的兼容性错误并失败。长上下文模式可以改变 pressure
压缩的触发时机，但不会改变 Native activation、codec、retention、v2 payload、回放兼容性
或一次性 turn-continuation 契约。回滚时只需重新选择 DSH 内置 preset；已有会话仍可通过
同级 Portable 文本继续，不需要迁移 profile 或会话。当 DSH 提供受支持的 provider-native
checkpoint Seam 时，应迁移到该 Seam，并删除本包的 carrier、请求 side channel、直接
transport、兼容性固定与自定义 Basic replacement；Portable Checkpoint 继续作为恢复路径。

仓库包含会消耗真实 Codex 配额的 live harness，但普通测试、`pnpm run check` 与 CI 都不会
运行它。它会拒绝 `CI`，并要求已有 Codex Login State 以及两个显式确认变量：

```sh
DSH_CODEX_NATIVE_LIVE=1 \
DSH_CODEX_NATIVE_LIVE_CONFIRM=I_UNDERSTAND_CODEX_LIVE_QUOTA \
pnpm run test:live:native-compaction
```

它验证真实 v2 创建、同进程一次性 turn continuation 与 Native 回放、重启/恢复回放、重复压缩
和诊断脱敏。没有另行授权
消耗 live Codex 配额时不要运行；实现过程和普通验证不会触达这一边界。

### Codex Native Checkpoint 回放

普通 `openai-codex` 推理会恢复兼容且已持久化的 **Dual Checkpoint**。在 pi-ai
转换 DSH 消息之前，Host 会把每条完整且有效的 checkpoint 消息替换成请求局部 marker；
provider payload hook 再在原位置把整条 marker item 替换为 canonical Codex Native
Checkpoint items，或替换为一条只含 Portable Checkpoint 的普通 user item。Native 与
Portable 两种表示绝不会同时发给 provider。持久化 block 可安全经过 JSON 存储、
`Session.fromRestore()` 与 `SessionStore.fork()`；重启恢复及 fork 后都能继续回放和再次压缩，
不需要改写 Session。追加新 trigger 之前，选定前缀中的每个兼容 checkpoint 都会在原 item
位置展开；不兼容 checkpoint 只贡献自己的 Portable message，因此仍可生成新的有效 Native
checkpoint 来替换该前缀。所有后续 tail message 与重复 pressure 的收敛或有界失败继续由
Basic 负责。

只有当 checkpoint 的 schema/codec/retention generation、provider、精确 model、哈希后的
Codex account identity、instructions、tools、parallel/tool-choice controls、reasoning、text
配置与 service tier 都匹配**最终生效**的 Responses 请求时，才会执行 Native 回放。组合的
payload callback 可以改变这些控制项；callback 完成后会重新判定并选择 Native 或 Portable。
Request ID、prompt-cache key、临时 header、turn state 与 Long Context Mode 不参与兼容性。
未知、损坏、超过 2 MiB、含 secret、混合格式或不兼容的状态会退化为 Portable 文本。生成的
marker 只存在于 Host；marker 缺失、重复、嵌入、泄漏或未消费时会在网络请求之前失败。
回放 converter 精确固定在 DSH LLM / pi-ai Adapter `0.1.1-rc.2` 与 pi-ai `0.82.1`；其他
runtime 组合只使用 Portable 文本。Adapter generation 替换或 HMR 会使进程内 replay 与
turn-continuation 状态失效，但不会修改持久化 Dual Checkpoint。

版本化 Host codec 通过 `dsh-codex-auth/native-checkpoint` 导出。它以 lossless JSON 保留
canonical 的纯文本 retained-user Responses items，并要求最后恰有一个 opaque compaction
item；credential、带命名空间的原始账号/路由标识、header、原始 turn state 与请求局部元数据
都会被拒绝，持久化的账号信息只有带 domain separation 的 hash。block 还带有空的通用展示
sentinel，因此 stock conversation 与 trajectory 只显示/复制同级 Portable 文本，不会把
opaque state JSON 化展示。该无凭据 opaque block 在 rc.2 中仍是敏感的普通 Session 数据，
可能存在于 Session RPC 与导出中，使用这些表面时仍须按敏感数据处理。issue 18 之前的
worktree 实验版本曾生成不含展示 sentinel 的 block；codec 为回放兼容仍可在 Host 解码它们，
但不保证通用 Trajectory 对这些从未发布的 fixture 隐藏内容。查看导入 Session 前应先迁移或
删除此类 fixture。

随 DSH 发布的 PiAiAdapter 与 direct DeepSeek Adapter 在 provider wire 上只发送 Portable
文本。转换使用脱离 Session 的请求副本，因此在下一次压缩前切回兼容 Codex route，仍可回放
保留的 Native 状态。切回 stock Basic preset 同样不需要迁移 Session；不兼容状态会继续走
Portable 文本。任意第三方 Adapter 若拒绝 declaration-merged 未知 block，仍属于该实验方案
的限制。Native 创建仍要求显式选择自定义 preset，也不会修改 `cordis.patch.yml`。

### 网页搜索

`codex-search` Host 行通过 `@deepseek-ai/dsh-web` 注册 ID 为 `codex` 的提供方。
bundle patch 会将它选为部署全局搜索提供方；用户后续 profile patch 仍可覆盖该选择。
每次搜索向官方独立搜索端点发起请求：

```text
https://chatgpt.com/backend-api/codex/alpha/search
```

若调用方是 `openai-codex` Agent，搜索会使用该 Agent 的当前模型；其他 provider
或无法解析调用方时使用设置中的备用模型。结果只包含后端生成的输出，以及从已识别字段
中提取、去重并验证过的 HTTP(S) 来源；不会编造标题、日期、摘要，也不会继续抓取网页。

网络错误与 HTTP 5xx 使用可取消的指数退避，最多尝试五次；HTTP 429 立即返回。

可实时生效的搜索设置：

| 设置 | 默认值 | 可选值 |
|---|---:|---|
| 启用 | `true` | 开 / 关 |
| 模式 | `live` | `live`、`cached`、`indexed` |
| 上下文大小 | `medium` | `low`、`medium`、`high` |
| 备用模型 | `gpt-5.4` | Codex 模型 ID |
| 最大输出 Token | `2048` | 正整数 |

### 图片创作

`generate_image` 对模型呈现为单一操作，并按有无参考图分发到官方 Codex 图片端点：

```text
POST https://chatgpt.com/backend-api/codex/images/generations
POST https://chatgpt.com/backend-api/codex/images/edits
```

参数包括必填 prompt、最多五个显式参考图、1–10 张输出、受支持的尺寸/质量/背景选项，
以及可选模型覆盖。参考图必须明确区分来源：

```json
{ "kind": "session", "handle": "image:<attachmentId>" }
{ "kind": "workspace", "path": "assets/reference.png" }
```

Session handle 只有在当前会话历史中的持久 ImageBlock 已授权对应附件时才可解析。
工作区读取必须留在当前 workspace 内，通过 `ctx.fs` 执行，并在远程请求前提升到附件存储。
不接受 HTTP(S) 参考图 URL。

后端返回的 base64 会经过编码大小限制、解码、文件签名检查、部署媒体策略验证，并通过
`ctx.attachments.saveImage(...)` 持久保存。多图响应会保留有效图片，并为缺失或无效条目
返回结构化 warning；只有一张有效图片都没有或响应 envelope 不可用时，整次调用才失败。
图片请求一旦发出便不会自动重试。

`list_images` 按最新优先分页列出当前会话的持久图片（默认 5 张、最多 10 张），支持不透明
cursor 和来源筛选，同时返回稳定 Image Handle 与真实 ImageBlock，使支持图片的模型在压缩
上下文后仍能查看旧图片。

图片工具只注册到使用 `openai-codex` 且明确声明支持图片输入的 Agent scope；执行时会再次
校验相同的路由、模型、登录态和套餐条件。若本地明确识别为 Free 套餐，会标记为不可用；
套餐未知时仍允许尝试，以后端结果为准。

可实时生效的图片设置：

| 设置 | 默认值 | 可选值 |
|---|---:|---|
| 启用 | `true` | 开 / 关 |
| 图片模型 | `gpt-image-2` | 图片模型 ID |
| 图片数量 | `1` | 1–10 |
| 尺寸 | `auto` | `auto`、`1024x1024`、`1536x1024`、`1024x1536` |
| 质量 | `auto` | `auto`、`low`、`medium`、`high` |
| 背景 | `auto` | `auto`、`opaque`、`transparent` |

成功的 `generate_image` 结果只展示 DSH 标准图片画廊；`list_images` 是供模型使用的目录状态，
不提供面向用户的结果视图。插件通过公开的会话授权附件 API 读取图片，使用有界 Blob URL 缓存，
并在连接重置、淘汰和插件卸载时回收自身 URL。生成图会作为对话附件持久保存。
DeepSeek Harness `0.1.1-rc.1` 尚未提供二进制工作区写入 API，因此界面不提供工作区导出操作；
插件也不会通过 Node 文件系统绕过 DSH 的文件策略。

### ACP 图片互操作

历史背景：DSH rc.7 引入了这里使用的 ACP 图片路径；当时如果当前 `openai-codex` 模型明确声明支持图片输入，ACP 客户端可以发送
PNG、JPEG、WebP 或 GIF 内联图片。DSH 会在用户消息入队前完成校验和持久化，因此这些图片
会作为普通的 `user` 图片进入本插件的图片目录，之后可通过 Image Handle 选作
`generate_image` 参考图。

历史背景：rc.7 的 ACP 桥接只发送已经提交到 `assistant/message` 的文本和图片块。`generate_image`
生成的图片仍位于 `tool/result` 内，因此 ACP 客户端不会直接收到这些生成图的二进制内容；
除非后续 assistant 消息自身包含 ImageBlock。

## 环境要求

- DeepSeek Harness `0.1.1-rc.1` 或兼容的后续 `0.1.x` 版本。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- `codex` CLI 已加入 `PATH`。
- 可提前执行 `codex login`，也可在 GPT Auth 卡片中启动登录。

最低兼容版本为 `0.1.1-rc.1`（见上方环境要求）。历史背景：rc.7 是第一个完整的 Web
设置功能基线，当时 Host 会把插件注册的 `codex-search`、`codex-image` 设置 namespace
暴露给浏览器；原版 rc.6 虽然能够注册 GPT Auth 分区，但这两个实时设置 scope 无法通过
远程接口读取或写入。

## 从 npm 安装（推荐）

npm 包已包含预构建的 Host 与浏览器 bundle，不需要安装期构建权限：

```sh
dsh plugin --profile web add dsh-codex-auth
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 安装预构建 Release

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.3.2/dsh-codex-auth-0.3.2.tgz
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 从 GitHub 源码安装

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth
```

Git 依赖会通过包内 `prepare` 脚本从源码构建。pnpm 10+ 默认阻止该脚本，因此第一次安装
可能打印 `allowBuilds` 键并停止。把 **dsh 输出的完整键** 加到
`~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 下，再重新执行安装。只应在审查并
信任源码后授权。

需要可复现安装时，固定 release tag 或 commit：

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.3.2
```

## 从 tarball 安装

```sh
git clone https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.3.2.tgz
```

## 升级

先停止正在运行的 `dsh web`，再将 Web Profile 更新到当前版本：

```sh
dsh plugin --profile web add dsh-codex-auth@0.3.2
dsh plugin --profile web list
```

列表显示 `dsh-codex-auth@0.3.2` 后，重新启动 `dsh web` 并刷新浏览器。

## Host 配置

能力包 patch 按依赖顺序启用三条独立 Host 行：

| 行 | Export | 作用 |
|---|---|---|
| `llm-codex-auth` | `dsh-codex-auth` | 共享认证协调器与 LLM 路由 |
| `codex-search` | `dsh-codex-auth/search` | 全局搜索提供方 |
| `codex-image` | `dsh-codex-auth/image` | Agent scope 图片工具 |

认证 / LLM 行字段全部可选。设置 `llmEnabled: false` 后仍保留供搜索/图片能力使用的
共享登录状态协调器，但不再注册 LLM 路由：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `llmEnabled` | `true` | 注册 `openai-codex` LLM 路由 |
| `authJsonPath` | `''` → `$CODEX_HOME`/`~/.codex/auth.json` | Codex 登录文件 |
| `credentialRef` | `CODEX_CHATGPT_TOKEN` | 状态卡展示的非敏感引用 |
| `refreshLeadMs` | `300000` | token 到期前的刷新提前量（毫秒） |
| `codexCommand` | `codex` | 登录和版本探测使用的 CLI 命令 |
| `displayName` | `OpenAI Codex (chatgpt)` | 模型选择器中的 provider 名称 |
| `longContextEnabled` | `false` | GPT-5.6 实时 1M 上下文策略的基础值；GPT Auth 设置可在 `codex-llm` namespace 覆盖它 |
| `transport` | `sse` | 流式传输方式：`sse`、`websocket` 或 `auto`（优先 WebSocket、失败回退 SSE）。默认 SSE：WebSocket 升级在常见 HTTP 代理下不稳定，且 `auto` 模式下每个新对话都要先付出连接超时才会回退 |
| `websocketConnectTimeoutMs` | `5000` | WebSocket 连接超时（毫秒，仅当 `transport` 不是 `sse` 时生效；`0` 表示禁用） |
| `timeoutMs` | `120000` | 请求超时（毫秒，SSE 响应头阶段；同时作为 WebSocket 消息空闲间隔；`0` 表示禁用） |

不要再在 `llm-pi-ai.providers` 下添加 `openai-codex`，也不要同时安装 `dsh-codex`；
重复路由所有权会得到明确诊断并被拒绝。

## 安全与限制

- token 值不会进入浏览器、设置、日志、会话事件、工具 metadata、搜索参数或图片结果；
  只有 Host 侧请求会收到认证 header。
- 状态可包含本地解码的账户 ID 和套餐 claim；它们是身份/状态信息，不是凭证。
- 刷新写回会保留未知字段，并以仅属主可读写（`0600`）权限原子替换登录文件。
- 状态/登录 RPC 通道只接受 loopback authority。
- 图片附件 ID 不是 bearer capability；会话历史中必须存在对应的持久 ImageBlock。
- 若 Codex 只把凭证放在系统钥匙串，`auth.json` 可能没有可用 token。可在
  `~/.codex/config.toml` 设置 `cli_auth_credentials_store = "file"`，再执行
  `codex login`。
- 在 DSH 提供受策略约束的二进制写入 API 之前，二进制 Workspace Export 暂不可用；
  对话附件持久化已经完整支持。

## 开发

```sh
pnpm install
pnpm run check
```

`pnpm run build` 生成：

- `lib/index.js`：认证 / LLM Host 插件；
- `lib/search.js`：搜索 Host 插件；
- `lib/image.js`：图片 Host 插件；
- `lib/compaction.js`：供自定义 preset 使用的实验性 Dual Checkpoint 压缩 Adapter；
- `lib/native-checkpoint.js`：版本化 Host codec 与回放兼容性契约；
- `lib/invariant.js`：invariant companion；
- `lib/client.js`：兼容 Loader、内联 CSS Modules 的浏览器插件；
- `lib/types/**`：类型声明。

另见 [`docs/design.md`](docs/design.md)、[`CONTEXT.md`](CONTEXT.md) 与
[架构决策记录](docs/adr/)。

## 友情链接

- [L 站](https://linux.do/)
