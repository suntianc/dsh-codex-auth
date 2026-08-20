# dsh-codex-auth

[![npm version](https://img.shields.io/npm/v/dsh-codex-auth.svg)](https://www.npmjs.com/package/dsh-codex-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

当前版本：**v0.2.2**

这是一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Codex 能力包**。它复用官方 **Codex CLI** 维护的 ChatGPT 登录态
（`~/.codex/auth.json`，或 `$CODEX_HOME/auth.json`），同时提供：

- `openai-codex` LLM 路由；
- 接入 DSH 内置 `web_search` 工具的全局 Codex 搜索提供方；
- 通过 `generate_image` 实现持久图片生成与编辑，并提供供模型使用的 `list_images` 目录；
- 稳健的 Codex 周用量状态；
- 一个原生 **GPT Auth** 设置分区，内含「登录」「网页搜索」「图片创作」三张卡片。

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
DeepSeek Harness `0.1.0-rc.7` 尚未提供二进制工作区写入 API，因此界面不提供工作区导出操作；
插件也不会通过 Node 文件系统绕过 DSH 的文件策略。

### ACP 图片互操作

在 DSH rc.7 中，如果当前 `openai-codex` 模型明确声明支持图片输入，ACP 客户端可以发送
PNG、JPEG、WebP 或 GIF 内联图片。DSH 会在用户消息入队前完成校验和持久化，因此这些图片
会作为普通的 `user` 图片进入本插件的图片目录，之后可通过 Image Handle 选作
`generate_image` 参考图。

rc.7 的 ACP 桥接只发送已经提交到 `assistant/message` 的文本和图片块。`generate_image`
生成的图片仍位于 `tool/result` 内，因此 ACP 客户端不会直接收到这些生成图的二进制内容；
除非后续 assistant 消息自身包含 ImageBlock。

## 环境要求

- DeepSeek Harness `0.1.0-rc.7` 或兼容的后续 `0.1.x` 版本。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- `codex` CLI 已加入 `PATH`。
- 可提前执行 `codex login`，也可在 GPT Auth 卡片中启动登录。

rc.7 是完整 Web 设置功能的最低基线：Host 会把插件注册的 `codex-search`、`codex-image`
设置 namespace 暴露给浏览器。原版 rc.6 虽然能够注册 GPT Auth 分区，但这两个实时设置
scope 无法通过远程接口读取或写入。

## 从 npm 安装（推荐）

npm 包已包含预构建的 Host 与浏览器 bundle，不需要安装期构建权限：

```sh
dsh plugin --profile web add dsh-codex-auth
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 安装预构建 Release

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.2.2/dsh-codex-auth-0.2.2.tgz
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
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.2.2
```

## 从 tarball 安装

```sh
git clone https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.2.2.tgz
```

## 升级

先停止正在运行的 `dsh web`，再将 Web Profile 更新到当前版本：

```sh
dsh plugin --profile web add dsh-codex-auth@0.2.2
dsh plugin --profile web list
```

列表显示 `dsh-codex-auth@0.2.2` 后，重新启动 `dsh web` 并刷新浏览器。

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
- `lib/invariant.js`：invariant companion；
- `lib/client.js`：兼容 Loader、内联 CSS Modules 的浏览器插件；
- `lib/types/**`：类型声明。

另见 [`docs/design.md`](docs/design.md)、[`CONTEXT.md`](CONTEXT.md) 与
[架构决策记录](docs/adr/)。

## 友情链接

- [L 站](https://linux.do/)
