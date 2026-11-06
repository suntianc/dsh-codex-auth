# DSH source compatibility verification

The current candidate targets DSH `0.2.2-rc.1` and pi-ai `1.3.0`. Both the registry
baseline and the source verification target use this exact coherent graph.
Cordis is pinned to `4.1.0` and Schemastery to `3.19.0`.
See [the upgrade guide](dsh-0.2.2-upgrade.md) for runtime changes and verification limits.
The records below describe previous releases, not the current compatibility range.

## Build the official artifacts once

Use a scratch directory outside the plugin checkout and any live DSH installation:

```sh
git clone --depth 1 --branch dsh-v0.2.2-rc.1 https://github.com/deepseek-ai/deepseek-harness.git harness
cd harness
git rev-parse HEAD
# Must be 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db.
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:lib
pnpm --filter './packages/**' --filter './vendor/*' -r pack --pack-destination ../dsh-packages
```

The Host and Client library build is required. Packing does not publish anything.

## Check this plugin

From the plugin checkout:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:dsh-source -- /absolute/path/to/dsh-packages /absolute/path/to/harness/patches/@earendil-works__pi-ai@1.3.0.patch
```

The source runner copies the plugin to a temporary directory, reads supplied
package manifests, rejects mixed DSH versions, and supplies the complete
DSH dependency/peer closure. It verifies the official pi-ai patch SHA-256
`4e1c90fd00aea42989664504668633033c1962e53c07860901edb4f72d843765`,
applies that patch in the isolated graph, and records artifact checksums.
It then runs the complete package gate. Local overrides and temporary paths
never enter a published package or user profile. Checksums identify the supplied
bytes; the fixed-tag build recipe establishes their provenance.

The optional source-artifact gate requires a complete tagged-source build;
registry tests and a packaged Desktop Host smoke are separate evidence and
must not be represented as a completed source-artifact gate.

## 中文说明

当前候选版本以 DSH `0.2.2-rc.1`、pi-ai `1.3.0`、Cordis `4.1.0` 和
Schemastery `3.19.0` 的一致依赖图为基线。源码验证脚本要求上面固定 tag 的
完整构建制品及准确的 Desktop pi-ai 补丁，并在临时目录内运行全部检查。
旧版验证记录不代表当前候选版本支持旧运行时。离线检查不证明真实 OAuth、搜索或图片后端可用。

## Historical release verification

## Upgrade from DSH 0.2.0-rc.2

The previous source tag is `dsh-v0.2.0-rc.2` at `639ed015397290b3745d163aafe02ffee4aa3f84`; the target is `dsh-v0.2.1-rc.1` at `1600d8a1e140dcde43a1a0941940a0480712c011`. The graph uses Cordis 4.0.5, Schemastery 3.18.5, and pi-ai 1.1.0. Three exact optional peers still prevent the released rc.4 bundle from loading on the new Host. No compatibility exemption is added: 0.3.4-rc.1 declares and checks the new coherent graph, rejects old/mixed experimental graphs, and leaves npm `latest` and `alpha` unchanged.

DSH removed the runtime invariant registry and companions. This package removes `@deepseek-ai/dsh-invariants` and the `dsh-codex-auth/invariant` export; remove any user-authored rows naming those modules. The normal three-row bundle never mounted them. Account routes now pass `browserPeer`, remain on Connection's owner-authenticated exact routes, and retain the explicit loopback-only guard. Settings tests use Config Forms without the removed `mode`, and stock image-tool fixtures use the current PartialArguments/phase contract.

Unlike the new generic PiAiAdapter, the Codex route keeps its existing static catalog policy: listing models does not resolve or refresh Login State. That avoids an empty cached catalog before login and preserves per-profile exclusion edits without authentication side effects. Real requests still resolve credentials through the single Host coordinator and fail with `MISSING_CREDENTIAL` when needed; listing is not evidence of account access.

The Session header remains V4 and Basic's compaction transaction is unchanged. Frozen synthetic fixtures from both 0.2.0 release candidates restore, fork and continue without rewriting native blocks. A fixture produced using the released rc.2 Session and codec is also replayed through the target adapter. Leading-system conversion changes are covered by the final instructions digest. The existing v1 digest does not model in-history instruction/tool availability updates, so final inputs containing system/developer messages, `additional_tools`, `tool_search_call` or `tool_search_output` stay Portable for both new creation and replay. This is a safety fallback, not a checkpoint migration or a downgrade guarantee.

The registry gate and source-artifact gate are separate. The source gate applies the pi-ai patch used by Desktop, rather than claiming unpatched npm bytes are the exact Desktop runtime. All account, settings, session and provider cases here use temporary synthetic fixtures or mocked transport. Installed Desktop replacement/restart, real profiles, OAuth, and live model/search/image backend operations remain unverified by these offline checks.

### 中文：0.2.0-rc.2 → 0.2.1-rc.1

0.3.4-rc.1 对齐完整新依赖图，不增加兼容性豁免，不更新稳定 `latest` 或 `alpha`。删除已退役的 invariant 模块；若自定义配置曾引用它们，应删除相关行。认证仍通过 Connection 的所有者认证路由和明确 loopback 限制。模型目录保持静态可见，不因打开选择器而读取或刷新登录态；真正请求仍须通过认证。

保留 V4 会话与 Native codec v1，验证旧合成会话恢复、分叉、继续和回放，不改写持久状态。旧 digest 无法表达的工具搜索及会话中指令更新使用 Portable 回退。源码检查明确应用 Desktop 的 pi-ai 补丁并记录哈希；这些离线证据不等于已安装桌面端、真实 OAuth 或私有后端实测。

## Upgrade from DSH 0.2.0-rc.1

The official tags are `dsh-v0.2.0-rc.1` at `4878cdabd87d4041bdaff61d04c966883b9fd07a` and `dsh-v0.2.0-rc.2` at `639ed015397290b3745d163aafe02ffee4aa3f84`. The relevant upstream change is pi-ai `0.85.1` → `0.87.1`, including catalog metadata and final Responses payload defaults. The Session header stays V4; core Session, JSONL persistence, credentials, settings, storage implementations, and profile compatibility readers are unchanged between these tags. A new qualified user-question reply source is recorded as a same-version extension; existing logs remain valid. This is forward-read evidence, not a downgrade guarantee for new rc.2 events.

The published `dsh-codex-auth@0.3.3-rc.2` declares three exact rc.1 peers: compaction, Basic compaction, and token-meter. DSH evaluates optional declared peers too, so upgrading the Host alone denies all three bundle rows before plugin import: authentication/LLM, Search, and Image. An rc.1 exemption does not authorize rc.2. Version `0.3.3-rc.3` updates the complete graph and exact gates instead of granting an exemption; it accepts rc.2 with pi-ai 0.87.1 and refuses mixed graphs, rc.1, or another pi-ai version. It uses the npm `rc` channel; the stable `latest` channel retains the previous stable release.

Desktop rc.2 also supplies its own CLI carrier for plugin management of the reserved Desktop profile and imports the macOS login-shell environment. An older npm `dsh` command may still exist on PATH; check `dsh --version` and use the intended rc.2 installation before managing a profile. These launcher changes are inspected in source, not exercised against the installed Desktop.

The synthetic regression in `tests/dsh-upgrade.spec.ts` invokes the real app-boot admission functions on temporary profile manifests and permissions. It verifies old-row denial, adapted-row admission without a grant, and unchanged synthetic configuration/login files. Its committed V4 fixture was produced by Session from the official rc.1 source build and the existing plugin codec; it contains only synthetic text and native state. The rc.2 Session implementation restores and forks that fixture, appends a new turn, and preserves both checkpoint representations. The Native replay regression separately proves that an old digest with omitted reasoning continues through Portable when pi-ai 0.87.1 sends explicit `reasoning: { effort: 'none' }`. Compatible newly captured Native checkpoints still replay through the offline provider tests. Codec/schema generations and durable bytes are not rewritten to force a match.

Run the complete package gate, including these regressions:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Run `check:dsh-source` with artifacts built from the pinned rc.2 tag to repeat the gate against the official source dependency graph. These checks never start the installed Desktop, load a real profile, or resolve live account credentials. Desktop application replacement/restart, actual persisted user logs, live OAuth, and provider availability remain unverified.

### 中文：rc.1 → rc.2

官方 tag 分别是上述 rc.1 / rc.2 提交。相关运行差异包括 pi-ai 升至 0.87.1、模型目录元数据和最终 Responses 载荷默认值；Session 头仍为 V4，会话持久化、凭据、设置、存储和 profile 版本豁免读取实现没有变化。新 user-question reply 来源被上游声明为同版本扩展，既有日志仍有效；这不证明 rc.2 新事件可降级读取。

Desktop rc.2 还新增自带的 CLI 管理入口，并读取 macOS login-shell 环境。旧 npm `dsh` 可能仍在 PATH 中，管理 profile 前应核对 `dsh --version`；本次未在已安装 Desktop 上验证这些启动器行为。

只升级 Host 会让已发布插件的三个精确 rc.1 peer 不匹配，即使这些 peer 标记 optional，DSH 仍会在 import 前拒绝认证/LLM、搜索、图片三条 bundle 行。旧 rc.1 豁免不会延续到 rc.2。`0.3.3-rc.3` 升级完整依赖图和精确运行门控，不增加豁免；使用 npm `rc` 预发布渠道，`latest` 保留既有稳定版本。合成 profile 回归确认旧行被拒绝、新行无需豁免即可准入，合成配置和登录文件保持原字节；rc.1 生成的 V4 Dual Checkpoint 可以恢复、分叉并继续。旧 Native digest 因 reasoning 默认值变化不匹配时，会使用 Portable 文本，不改写旧 checkpoint。所有这些证据均来自隔离、离线检查，不是本机 Desktop 实际升级成功。

## 2026-10-17 verification record

- Plugin candidate: `0.3.4-rc.1`; Node `24.19.0`, project pnpm `11.7.0`.
- Frozen registry install and complete `pnpm run check`: 24 test files, 441 tests; peer checks, lint, Host/client type checks, build, packaged-artifact smoke and publint passed.
- Official source at `1600d8a1e140dcde43a1a0941940a0480712c011`: Host/client library build and package packing passed. The isolated plugin check selected 97 source closure artifacts, recorded their SHA-512 hashes, and applied the verified pi-ai patch above. The same complete gate and 441 tests passed there.
- Final account-route coverage checks unauthenticated and untrusted-origin denial, non-owner Peer denial before the delegate, owner `browserPeer` forwarding, malformed requests, route disposal, and the retained loopback guard.
- Image row lifecycle regressions use real Cordis plugin fibers and deferred Login State completion: active refreshes continue, while late initial-status and watcher callbacks no longer touch disposed services. Both new cases failed before the lifecycle guard and pass with it.
- These results do not establish installed Electron/Desktop behavior, live OAuth, or live model, search and image backend availability.


## 0.3.4-rc.2: rc.1 / rc.2 compatibility matrix

The installed Desktop may auto-update independently of a plugin release. The published 0.3.4-rc.1 package correctly remains the immutable rc.1-only artifact; its three exact optional peers are checked before installation and deny rc.2. Changing only peer metadata would still leave the Native replay and compaction gates refusing rc.2.

This checkout declares the finite semver union `0.2.1-rc.1 || 0.2.1-rc.2` for those three peers and the same supported runtime set internally. The Host uses `semver.satisfies` with `includePrerelease: true`; explicit alternatives avoid accidentally admitting rc.1.1, rc.2.1, rc.3, stable 0.2.1, or another minor release. Every experimental runtime package must still belong to one identical supported graph, and pi-ai must still be exactly 1.1.0. No `engines.dsh` override or compatibility exemption bypasses peer checks.

Official tags: rc.1 = `1600d8a1e140dcde43a1a0941940a0480712c011`; rc.2 = `687f282e8625c6b8d11ff58211a90524be2e4317`. Comparing the 72 referenced Host/client/development packages finds source changes only in dsh-web: search/fetch configuration becomes volatile and is read for each request. Session, Basic compaction, token meter, LLM/pi-ai conversion, account RPC, plugin admission, Cordis and the exact pi-ai patch are unchanged. rc.2 also adds official DeepSeek search/fetch providers and display/settings plugins. Codex continues using the stock Web registration interface and the bundle's explicit provider selection; tests construct WebRuntime through its own Config schema so both contracts are exercised correctly.

The complete package gate must pass separately on rc.1 and rc.2. For a packed official-source graph, set `DSH_VERIFY_VERSION=0.2.1-rc.1` to select the old pinned source identity, or omit it for the rc.2 source target. Do not mix source artifacts. Registry baseline scripts default to rc.1; alternate graph checks set `DSH_VERIFY_VERSION=0.2.1-rc.2` and install the complete rc.2 development closure in an isolated checkout.

Version `0.3.4-rc.2` carries this compatibility update on the npm `rc` channel and GitHub prerelease channel. Installation and offline Host checks do not establish rendered Desktop UI, live OAuth, model, search backend or image-generation behavior.


Real profile loading also exposes a pre-existing metadata lookup defect: Node's `findPackageJSON` on a bare specifier uses the built-in resolver, rather than the DSH installation/profile interception. The reader now resolves the ESM entry first and then locates its package metadata; a custom-resolver, import-only package fixture and both actual Host loaders cover this distinction. The strict coherent-graph and exact pi-ai guard remain intact. See [Node's resolver caveat](https://nodejs.org/api/module.html#modulefindpackagejsonspecifier-base).

The local installation matrix uses the official `initProfile` output, including `nodeLinker: hoisted` and `autoInstallPeers: false`, then the real `dsh plugin add` command. Omitting that generated configuration creates an invalid test environment with pnpm-injected duplicate Host dependencies; successful admission in such a directory alone is not runtime compatibility evidence. The valid matrix checks the imported pi-ai and Basic engine against the actual Host modules, normal teardown, and immediate unload. rc.2 uses the installed Desktop carrier; rc.1 uses the official isolated CLI graph with the exact Desktop pi-ai 1.1.0 patch. No live credentials, provider requests, or user profile changes are involved.
