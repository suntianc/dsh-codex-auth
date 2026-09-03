# DSH 0.1.0-rc.6 → 0.1.0-rc.7 变更核验

> 核验时间：2026-08-20 UTC。本文只使用官方 npm registry 与
> `deepseek-ai/deepseek-harness` 仓库的一手资料。

## 结论

本机安装的是 `@deepseek-ai/dsh@0.1.0-rc.6`；npm `latest` 是 `0.1.0-rc.7`，`next` 是 `0.1.0-rc.8`。`npm outdated -g` 给出的 `Current / Wanted / Latest` 为 `rc.6 / rc.7 / rc.7`，因此更新真实存在。

rc.7 不是只有 CLI 版本号变化，而是整套 DSH bundle 的协调发布：CLI 的内部 `@deepseek-ai/dsh-*` 依赖整体切到 `rc.7`。官方 rc.7 标签提交为 [`99f6f02`](https://github.com/deepseek-ai/deepseek-harness/commit/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca)，其前一个 rc.6 发布合并提交为 [`fb826987`](https://github.com/deepseek-ai/deepseek-harness/commit/fb82698709c39f1860b0ab0ed147e1fa30c1d5d0)。

## 对用户最有感的改动

### 1. 提问卡片可收起

Ask-user 问题卡增加收起/展开按钮。收起后只保留标题栏，让用户重新看到上方会话；当前题目、已选答案和草稿不会丢失。收起状态还正确反映到 `aria-expanded`，并且不会把隐藏控件留在无障碍树中。

来源：[官方实现说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/feature/2026-08-11-collapsible-ask-user-question-card.zh.md)、[`QuestionComposer.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/client/ui-user-questions/src/client/QuestionComposer.tsx#L79-L85)。

### 2. 达到输出上限时不再“静默结束”

模型因 `max-tokens` 截断时，聊天记录会显示警告节点，并明确说明已有输出保留、可发送“继续”。该节点可在实时流、刷新和历史回放中重建，不再把截断误显示成正常完成。

同时修复了截断响应的回放元数据与实际内容不一致的问题：被截断、不能安全执行的工具调用及其对应元数据会一起移除；旧的损坏回放状态会降级为普通内容并继续运行，而不是把整个会话永久卡死。

来源：[截断提示说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/bug-fix/2026-08-12-max-tokens-turn-end-notice.zh.md)、[回放状态修复说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/bug-fix/2026-08-15-max-token-replay-state-alignment.zh.md)、[`BlockAssembler`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/llm/llm/src/assembler.ts#L128-L177)。

### 3. DeepSeek 增加 Low 推理强度

DeepSeek 模型能力列表新增 `Low` reasoning effort，并会在请求中发送 `reasoning_effort: "low"`；此前只有 Off/High/Max。这样模型选择页和实际请求的选项保持一致。

来源：[DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/llm/llm-deepseek/src/adapter.ts#L95-L107)、[请求序列化](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/llm/llm-deepseek/src/serialize.ts#L25-L52)。

### 4. Codex / Claude Code 子代理可显式放到后台

启用了相应可选提供方的 preset 中，产品 one-shot subagent 支持 `run_in_background: true`：立即返回通用 Job id，可用 `job_output`、`job_list`、`job_kill` 收集或取消。默认仍是前台等待；这不是可恢复的产品会话，只是复用通用 Job 生命周期。

来源：[官方设计说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/feature/2026-08-12-product-subagent-one-shot-background-tasks.zh.md)、[`tool-subagent`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/subagent/tool-subagent/src/index.ts#L38-L48)。

### 5. ACP / 图片内容桥接更完整

ACP 现在可以在模型明确声明支持图片、且部署挂载附件服务时，接收并持久化 PNG/JPEG/WebP/GIF inline image，也能把助手图片读回 ACP；不支持图片的路由会明确拒绝，而不是静默丢弃。附件批量写入先完成整批校验再提交，减少半成功状态。

注意：rc.7 的原生 DeepSeek chat-completions adapter 仍声明为 text-only，并会拒绝图片内容；不要把这次 ACP/附件桥接改动理解成 rc.7 已经给 DeepSeek 直连开启视觉输入。

来源：[ACP 内容桥接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/acp/acp/src/content.ts#L62-L80)、[附件批量校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/attachment/attachment/src/index.ts#L47-L73)、[DeepSeek text-only 声明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/packages/llm/llm-deepseek/src/adapter.ts#L109-L116)。

### 6. 插件可以自己拥有 Web 设置页

已注册 settings 命名空间的插件不再需要修改 `api-proxy` 内的硬编码白名单；插件可按命名空间注册自己的设置卡片，Web 设置页按 Host 注册和客户端卡片的交集渲染。敏感字段仍由 `role('secret')` 脱敏。

来源：[插件设置表层说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.zh.md)。

## 稳定性和工程侧改动

- Safari 删除文字跨越软换行时，修复 textarea 原生布局陈旧导致的光标错位和多余滚动高度；只在 Safari 且观测到缩短/溢出时触发布局恢复。[说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/bug-fix/2026-08-13-safari-textarea-soft-wrap-reflow.zh.md)
- 大量 `sourceEventSeqs` 的历史分页改为逐项扫描，避免展开超大数组触发 JavaScript 参数数量上限。[说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/bug-fix/2026-08-04-large-history-pagination-call-stack.zh.md)
- persistent Bash 不再假设固定 shell prompt，改用 PTY 的 `stdin_read`/完成 marker 判断，减少 minimal mode 下 prompt 泄漏、误判和超时。
- PowerShell Web E2E overlay 改为按 id override，修复 `duplicate loader entry id: tool-pwsh` 启动冲突。
- `node-pty` 升级到 `1.2.0-beta.15`，支持外置 spawn-helper 路径，并补强 Python SDK native-PTY 可执行文件构建/校验。
- 发布流程增加依赖顺序、可选依赖导入和客户端运行时依赖校验；Python SDK 增加真实打包运行时的 model-visible 快照校验。
- 内置英文 preset 的显示名从 `Code mode` 改为 `PTC mode`，中文原本已是“PTC 模式”。这是命名调整，不是新能力。

## 版本边界

本文比较的是 rc.6 → rc.7。npm 的 `next` rc.8 不纳入结论；rc.8 后续提交中的原生 DeepSeek vision 等能力不能提前归给 rc.7。

官方包入口：[npm `@deepseek-ai/dsh`](https://www.npmjs.com/package/%40deepseek-ai/dsh)，实时 registry 元数据：[npm registry JSON](https://registry.npmjs.org/@deepseek-ai/dsh)。
