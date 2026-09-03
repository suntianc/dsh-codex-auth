# DSH 已发布版本核验

> 核验时间：2026-08-20T12:51:34Z。`pwd` 返回当前仓库为 `/Users/suntc/project/dsh-codex-auth`；本文沿用该仓库已有的 `docs/research/` 研究笔记约定（`docs/research/dsh-rc7-changes.md`、`docs/research/codex-remote-context-compaction.md`），且只使用官方 npm registry、官方 `deepseek-ai/deepseek-harness` GitHub Release 与本机安装目录中的包清单。

## 结论

**有更新的已发布版本。** 本机安装的是 `@deepseek-ai/dsh@0.1.0-rc.7`，而 npm registry 已收录更高的 `0.1.0-rc.8`。不过 npm 当前把 `0.1.0-rc.8` 标为 `next`，把 `0.1.0-rc.7` 保持为 `latest`；因此，默认 `latest` 通道并未领先本机，但预发布 `next` 通道领先一个 RC。[npm registry 元数据](https://registry.npmjs.org/@deepseek-ai/dsh)；本机清单：`/Users/suntc/.nvm/versions/node/v22.21.0/lib/node_modules/@deepseek-ai/dsh/package.json`（第 2–4 行）。

## 版本与日期

| 项目 | 版本 / 日期 | 一手来源 |
|---|---|---|
| 本机安装版本 | `0.1.0-rc.7` | `/Users/suntc/.nvm/versions/node/v22.21.0/lib/node_modules/@deepseek-ai/dsh/package.json`（第 2–4 行） |
| npm `latest` | `0.1.0-rc.7` | [npm registry 元数据](https://registry.npmjs.org/@deepseek-ai/dsh) |
| npm `next` / 最高已发布版本 | `0.1.0-rc.8` | [npm registry 元数据](https://registry.npmjs.org/@deepseek-ai/dsh) |
| `rc.8` npm 发布时间 | `2026-08-19T15:41:29.655Z` | [npm registry 元数据的 `time["0.1.0-rc.8"]`](https://registry.npmjs.org/@deepseek-ai/dsh) |
| `rc.8` GitHub Release 发布时间 | `2026-08-19T15:37:57Z`；GitHub 标记为 prerelease | [官方 `v0.1.0-rc.8` Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8) |
| `rc.8` 标签提交 | `141eb6fef83422698aef7a981029e843e8161534` | [官方标签提交](https://github.com/deepseek-ai/deepseek-harness/commit/141eb6fef83422698aef7a981029e843e8161534) |
| 本机版本 `rc.7` npm 发布时间 | `2026-08-17T11:50:59.194Z` | [npm registry 元数据的 `time["0.1.0-rc.7"]`](https://registry.npmjs.org/@deepseek-ai/dsh) |
| 本机版本 `rc.7` GitHub Release 发布时间 | `2026-08-17T12:01:58Z` | [官方 `v0.1.0-rc.7` Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7) |

## `rc.8` 官方列出的主要变化

以下是官方 Release Notes 的摘要，不包含第三方解读：

- **多模态与引用：** DeepSeek adapter 可配置原生图片请求；`/goal`、`/plan` 等命令接受图片输入；`@` 菜单支持文件与会话引用。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **子代理：** Claude Code 与 Codex 子代理可按需作为 Profile Bundle 安装；Codex 新增非交互权限模式和命名实例。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **Windows 终端：** Windows PTY 新增持久 PowerShell 会话，并在 Minimal preset 中默认启用。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **可靠性修复：** 限制过大或累计过多的图片载荷；取消流式生成后保留已显示的回复前缀供后续提问与分叉使用；修复部分 OpenAI-compatible gateway 的请求格式和 reasoning-content 问题。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **工具、启动与性能：** `web_search` 支持并发查询，子代理 `reportDelivery` 可及时反馈并唤醒父任务；本地 `dsh web` 默认自动打开浏览器；大历史会话分叉性能得到改善。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **兼容性注意事项：** SQLite 后端的读写、分叉性能和存储体积得到改善，但官方明确说明其存储格式不兼容。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- **Python SDK：** 打包运行时覆盖四个内置 Agent preset，并补齐 `rg` / glob 搜索和 MCP stdio 工具所需依赖。[官方 `rc.8` Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)

## 更新判断

若“最新”指 npm 默认安装通道 `latest`，本机 `rc.7` 已是该通道版本；若“最新发布”指 registry 中版本号最高、且已有官方 GitHub Release 的版本，则 `rc.8` 是更新版本，但它仍处于 npm `next` 与 GitHub prerelease 通道。[npm registry 元数据](https://registry.npmjs.org/@deepseek-ai/dsh)；[官方 `rc.8` Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)。
