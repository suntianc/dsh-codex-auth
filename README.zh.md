# dsh-codex-auth

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

这是一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
插件：复用官方 **Codex CLI** 维护的 ChatGPT 登录态（`~/.codex/auth.json`，或
`$CODEX_HOME/auth.json`），注册 `openai-codex` LLM 路由，并在 Harness 设置中增加
原生风格的独立 **GPT Auth** 分区。

> **⚠️ 非官方通道——仅限个人开发。** pi-ai 的 Codex provider 使用非官方
> `chatgpt.com/backend-api`，可能随时被限流、撤销或变更，不得用于生产。

## 功能

- 使用已安装的 pi-ai provider 注册 `openai-codex` 路由。
- 仅在需要时读取 Codex access token，并在到期前通过官方 OAuth token 端点刷新。
- 启动官方 `codex login` 浏览器登录或设备码登录流程。
- 使用 DSH 原生按钮、状态点和语义 token，提供独立 `GPT Auth` 设置分区；菜单使用
  DSH 默认齿轮图标。
- 使用插件自有、仅允许 loopback 的 `/codex-auth` Connection RPC。
- token 值不会发送到浏览器、Harness 设置或日志。
- 不修改 Harness Web shell、apiproxy 或源码。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6` 或兼容的后续 `0.1.x` 版本。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- `codex` CLI 已加入 `PATH`。
- 可提前执行 `codex login`，也可在 GPT Auth 卡片中启动登录。

## 从 npm 安装（推荐）

npm 包已包含预构建的 Host 与浏览器 bundle，不需要安装期构建权限：

```sh
dsh plugin --profile web add dsh-codex-auth
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 安装预构建 Release

Release tarball 已包含 Host 与浏览器构建产物，不需要安装期构建权限：

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.1.0/dsh-codex-auth-0.1.0.tgz
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 从 GitHub 源码安装

安装到实际运行的 profile：

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth
```

Git 依赖会通过包内 `prepare` 脚本从源码构建。pnpm 10+ 默认阻止该脚本，因此第一次
安装可能打印 `allowBuilds` 键并停止。把 **dsh 输出的完整键** 加到
`~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 下，再重新执行安装。只应在
审查并信任源码后授权。

需要可复现安装时，固定 release tag 或 commit：

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.1.0
```

重启 `dsh web`，打开设置并选择 **GPT Auth**。

## 从 tarball 安装

Tarball 已包含 Host 与浏览器构建产物，不需要安装期构建权限：

```sh
git clone https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.1.0.tgz
```

## 配置

插件行字段全部可选：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `authJsonPath` | `''` → `$CODEX_HOME`/`~/.codex/auth.json` | Codex 登录文件 |
| `credentialRef` | `CODEX_CHATGPT_TOKEN` | 状态卡展示的非敏感引用 |
| `refreshLeadMs` | `300000` | token 到期前的刷新提前量（毫秒） |
| `codexCommand` | `codex` | 登录和版本探测使用的 CLI 命令 |
| `displayName` | `OpenAI Codex (chatgpt)` | 模型选择器中的 provider 名称 |

本包自带 `dsh.bundle` patch，`dsh plugin` 会同时安装并启用。不要再在
`llm-pi-ai.providers` 下添加 `openai-codex`，重复注册会冲突。

## 安全与限制

- token 内容不会跨越专用 RPC；状态仅含可用性、登录方式、到期时间、刷新时间和
  非敏感引用。
- 刷新写回会保留未知字段，并以仅属主可读写（`0600`）权限原子替换登录文件。
- RPC 通道只接受 loopback authority。
- 若 Codex 只把凭证放在系统钥匙串，`auth.json` 可能没有可用 token。可在
  `~/.codex/config.toml` 设置 `cli_auth_credentials_store = "file"`，再执行
  `codex login`。
- 登录缺失或刷新失败会产生 `MISSING_CREDENTIAL` 诊断；Codex CLI 缺失时登录按钮
  会被禁用。

## 开发

```sh
pnpm install
pnpm run check
```

`pnpm run build` 生成：

- `lib/index.js`：Host 插件
- `lib/invariant.js`：invariant companion
- `lib/client.js`：兼容 DSH Loader、内联 CSS Modules 的浏览器插件
- `lib/types/**`：类型声明

`build/client-bundle.ts` 内置本双面插件所需的最小 Web Loader 与 CSS 构建契约，
不依赖旁边存在 DeepSeek Harness 源码 checkout。

设计记录与术语见 [`docs/design.md`](docs/design.md)。

## 友情链接

- [L 站](https://linux.do/)
