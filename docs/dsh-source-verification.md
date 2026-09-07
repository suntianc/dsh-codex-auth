# DSH source compatibility verification

This plugin supports two separately checked DSH graphs: npm `0.1.2-alpha.5` and
the official `0.1.3-alpha.1` source tag at
`d347e703908d0406b7a7ef80e3a0e594d86b2215`.
The latter was not available on npm when this upgrade was verified. Therefore the
ordinary development dependencies and lockfile retain the installable alpha.5
baseline. Peer ranges explicitly include the new prerelease; they do not imply
support for arbitrary prereleases. Do not mix the two graphs.

## Build the official artifacts once

Use a separate scratch directory, outside any plugin or live DSH installation:

```sh
git clone --depth 1 --branch dsh-v0.1.3-alpha.1 https://github.com/deepseek-ai/deepseek-harness.git harness
cd harness
git rev-parse HEAD
# Must be d347e703908d0406b7a7ef80e3a0e594d86b2215.
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
while continuing to verify the selected version. The default check remains on
alpha.5; the source runner selects alpha.1 using `DSH_VERIFY_VERSION`.

## 中文说明

本次增加对 DSH `0.1.3-alpha.1` 固定源码版本的支持，同时保留
`0.1.2-alpha.5` 的可安装开发依赖与锁文件。原因是目标 DSH npm 包尚未发布。
两套图分别完成验证，不能混用；这不是跳过 peer 检查。

按上面的固定 tag 构建、打包一次，然后在本插件目录运行
`pnpm run check:dsh-source -- /绝对路径/dsh-packages`。脚本在临时目录内安装
完整源码包图并运行全部检查，输出位置和制品哈希供复核。正式 package.json
和锁文件不会写入本机临时路径，也不会安装到现用 profile。

升级验证覆盖离线类型检查、测试、构建、打包 smoke 和 publint；
真实 OAuth、私有服务请求和用户现用 profile 不属于这些离线检查的证明范围。
