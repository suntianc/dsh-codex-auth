# DSH 0.1.0-rc.7：插件生态与插件-facing surface

> 范围：只核对官方 `dsh-v0.1.0-rc.7` Release、该 tag 下的源码/实现说明，以及官方 npm registry 元数据。已有研究笔记位于 [`docs/research/dsh-rc7-changes.md`](./dsh-rc7-changes.md) 与 [`docs/research/dsh-published-version-check.md`](./dsh-published-version-check.md)。本文只提炼插件生态和插件作者可见的契约，不把一般 UI、模型或稳定性修复算作插件 API。

## 结论

rc.7 对插件生态最实质的变化是：**插件可以同时拥有 Host settings 命名空间和 Web 设置卡片，页面按命名空间自动配对，不再要求插件作者修改 `api-proxy` 的内置白名单。** Release notes 将“各插件可自行注册设置卡片”列为 New Feature；实现说明进一步定义了注册、派发和脱敏边界。[官方 rc.7 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)；[tagged implementation note](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.zh.md)

## 1. 真正的插件/API-facing 变化

### 1.1 插件自有 settings card

- Host 侧不再依赖 `WEB_SETTINGS_NAMESPACES`、`PRODUCT_SETTINGS_NAMESPACES` 等硬编码白名单；已注册 settings 命名空间由 settings service 提供，未知或不可寻址的名字才被拒绝。[实现说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.zh.md)
- `settings.plugin.item` 从无序 list 变为 **keyed slot**：卡片以它编辑的 settings 命名空间作为 `key`，不再声明 `id`/`order`。Web 的“插件配置”页读取 Host 实际服务的命名空间，只向对应 key 的卡片派发；两者没有交集就不渲染。[实现说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.zh.md)
- 插件因此需要交付两个半侧：Host 侧注册命名空间；浏览器侧以该命名空间为 key 注册卡片。卡片外观、控件和文案由插件自己拥有，页面不提供 schema 兜底表单。[官方 rc.7 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/docs/cookbook/adding-a-settings-card.zh.md)
- `role('secret')` 字段仍按字段脱敏，不应把“注册即暴露”误读成敏感值会进入响应；配置卡片通过 settings scope 的 revision 读写机制更新/取消字段。[官方 rc.7 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/docs/cookbook/adding-a-settings-card.zh.md)

这是一项插件-facing seam 变化，而不是单纯的页面换肤：第三方插件可在仓库外提供自己的 settings namespace 与 `dsh.client` 卡片，按 cookbook 的 Host/client 两半接入。[官方 rc.7 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.7/docs/cookbook/adding-a-settings-card.zh.md)

### 1.2 发布生态的同步切换

官方 npm 的 `@deepseek-ai/dsh@0.1.0-rc.7` 元数据把 CLI 描述为“profile boot, plugin management, and the browser UI alias”，并将内置 `@deepseek-ai/dsh-*` 依赖整体指向 `^0.1.0-rc.7`；这说明 rc.7 是协调发布的插件包生态版本，而不是只有顶层 CLI 的版本号变化。[npm rc.7 package metadata](https://registry.npmjs.org/@deepseek-ai/dsh/0.1.0-rc.7)

同一份官方 npm 元数据还确认 CLI 的 plugin-facing 入口是 `dsh plugin --profile <name> <pnpm args>`；插件依赖安装在 profile 自己的目录中，属于 profile 的扩展面，而非修改应用源码的内置集成。[npm rc.7 package metadata](https://registry.npmjs.org/@deepseek-ai/dsh/0.1.0-rc.7)；[官方 npm package README](https://www.npmjs.com/package/%40deepseek-ai/dsh)

## 2. 与插件有关但不是 API 契约的变化

- **Cordis 动态插件面板**：Release notes 把它列为 Improvement（“Refine the Cordis dynamic plugin panel”）。这是插件管理 UI/体验优化；Release notes 没有把它描述为新的插件注册接口。[官方 rc.7 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)
- **Codex/Claude Code 子代理进入 Job Panel**：Release notes 将其列为 New Feature，但它是内置子代理任务的 Job Panel 集成，不是第三方插件 settings/loader API；应与插件卡片 seam 分开记录。[官方 rc.7 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)
- **MCP/ACP 持久化图片、PTC 嵌套图片转发**：这是协议/附件能力；虽然会影响 MCP/ACP 相关插件能处理的内容，但 Release notes 没有声明新的通用插件注册 API。[官方 rc.7 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)

## 3. 明确排除：一般 UI、模型与 bug 修复

持久 Bash 极简模式卡顿、大历史分页栈溢出、`max-tokens` 截断后的会话续接、Safari 输入框错位、node-pty 升级，以及提问卡片折叠、DeepSeek `low` reasoning effort、`Code mode` 更名为 `PTC mode`，均属于 Release notes 的 Bug Fixes 或 Improvements；它们不是本次插件-facing settings/loader 契约的变化。[官方 rc.7 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)

## 4. 版本边界

本文不把后续版本能力倒灌到 rc.7；npm registry 的固定版本元数据只用于确认 rc.7 的包名、版本、入口和内部依赖范围。[npm rc.7 package metadata](https://registry.npmjs.org/@deepseek-ai/dsh/0.1.0-rc.7)
