# DSH source compatibility verification

This checkout targets the published DSH `0.2.0-rc.2` graph and its matching
source tag at `639ed015397290b3745d163aafe02ffee4aa3f84`. Development dependencies,
the lockfile, peer ranges, and package smoke checks use this baseline. Codex's
experimental compaction and Native replay additionally require pi-ai `0.87.1`
and the exact DSH graph. Older plugin releases retain the earlier DSH support;
the current checkout does not test or advertise that older graph.

## Build the official artifacts once

Use a separate scratch directory, outside any plugin or live DSH installation:

```sh
git clone --depth 1 --branch dsh-v0.2.0-rc.2 https://github.com/deepseek-ai/deepseek-harness.git harness
cd harness
git rev-parse HEAD
# Must be 639ed015397290b3745d163aafe02ffee4aa3f84.
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:lib
pnpm --filter './packages/**' --filter './vendor/*' -r pack --pack-destination ../dsh-packages
```

The Host and Client library build is required. Packing does not publish anything.
The resulting directory can be reused to check each of the four plugins.

## Check this plugin

From this plugin's own repository:

```sh
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --frozen-lockfile
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm run check
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm run check:dsh-source -- /absolute/path/to/dsh-packages
```

The temporary `PNPM_CONFIG_MINIMUM_RELEASE_AGE=0` override permits verifying
the newly published release before the configured registry age window expires;
it does not change the workspace policy.

The source check copies the current plugin into a new temporary directory,
reads the supplied tarball manifests, rejects mixed DSH versions, explicitly
supplies the complete DSH dependency/peer closure, and pins pi-ai to the plugin's
development version when present. It installs that isolated graph and runs
`pnpm peers check` followed by the unmodified `pnpm run check` command.

The runner leaves the verification directory and `artifacts.json` with SHA-512
checksums for review. The fixed-tag build recipe establishes provenance; the
runner identifies the supplied bytes and checks their versions, and does not
claim to authenticate arbitrary user-supplied tarballs. Its local file overrides
and generated lockfile stay in the temporary directory. They never enter this
repository, an installed package, or a user profile.

Package smoke checks accept both registry and source-artifact lock identities
while continuing to verify the selected version. Both registry and source
checks target `0.2.0-rc.2`; source checks use `DSH_VERIFY_VERSION` explicitly.

## 中文说明

当前检出版本以已发布的 DSH `0.2.0-rc.2` 为开发与最低支持基线，
锁文件、peer 与打包检查使用同一套依赖图。Codex 实验性压缩与 Native 回放
还要求 pi-ai `0.87.1` 及准确的 DSH 版本；旧 DSH 请保留旧插件版本。

按上面的固定 tag 构建、打包一次，然后在本插件目录运行
`pnpm run check:dsh-source -- /绝对路径/dsh-packages`。脚本在临时目录内安装
完整源码包图并运行全部检查，输出位置和制品哈希供复核。正式 package.json
和锁文件不会写入本机临时路径，也不会安装到现用 profile。

升级验证覆盖离线类型检查、测试、构建、打包 smoke 和 publint；
真实 OAuth、私有服务请求和用户现用 profile 不属于这些离线检查的证明范围。

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
