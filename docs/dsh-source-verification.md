# DSH source compatibility verification

This checkout targets the published DSH `0.1.5-rc.1` graph and its matching
source tag at `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. Development dependencies,
the lockfile, peer ranges, and package smoke checks use this baseline. Codex's
experimental compaction and Native replay additionally require pi-ai `0.85.1`
and the exact DSH graph. Older plugin releases retain the earlier DSH support;
the current checkout does not test or advertise that older graph.

## Build the official artifacts once

Use a separate scratch directory, outside any plugin or live DSH installation:

```sh
git clone --depth 1 --branch dsh-v0.1.5-rc.1 https://github.com/deepseek-ai/deepseek-harness.git harness
cd harness
git rev-parse HEAD
# Must be 183f08e9c6dde7e36cd2318eaee70b0da08fb35e.
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:lib
pnpm --filter './packages/**' --filter './vendor/*' -r pack --pack-destination ../dsh-packages
```

The Host and Client library build is required. Packing does not publish anything.
The resulting directory can be reused to check each of the four plugins.

## Check this plugin

From this plugin's own repository:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:dsh-source -- /absolute/path/to/dsh-packages
```

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
checks target `0.1.5-rc.1`; source checks use `DSH_VERIFY_VERSION` explicitly.

## 中文说明

当前检出版本以已发布的 DSH `0.1.5-rc.1` 为开发与最低支持基线，
锁文件、peer 与打包检查使用同一套依赖图。Codex 实验性压缩与 Native 回放
还要求 pi-ai `0.85.1` 及准确的 DSH 版本；旧 DSH 请保留旧插件版本。

按上面的固定 tag 构建、打包一次，然后在本插件目录运行
`pnpm run check:dsh-source -- /绝对路径/dsh-packages`。脚本在临时目录内安装
完整源码包图并运行全部检查，输出位置和制品哈希供复核。正式 package.json
和锁文件不会写入本机临时路径，也不会安装到现用 profile。

升级验证覆盖离线类型检查、测试、构建、打包 smoke 和 publint；
真实 OAuth、私有服务请求和用户现用 profile 不属于这些离线检查的证明范围。
