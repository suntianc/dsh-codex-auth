# dsh-codex-auth

English | [中文](README.zh.md)

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin that reuses the ChatGPT login maintained by the official **Codex CLI**
(`~/.codex/auth.json`, or `$CODEX_HOME/auth.json`). It registers the
`openai-codex` LLM route and adds a native **GPT Auth** section to the Harness
Settings UI.

> **⚠️ Unofficial channel — personal development only.** The pi-ai Codex
> provider talks to the unofficial `chatgpt.com/backend-api` surface. It may be
> rate-limited, revoked, or changed at any time and must not be relied on for
> production use.

## Features

- Registers the `openai-codex` route using the installed pi-ai provider.
- Reads the current Codex access token only when needed and refreshes it through
  the official OAuth token endpoint before expiry.
- Starts the official `codex login` browser or device-code flow.
- Adds an independently navigable `GPT Auth` Settings section using native DSH
  buttons, status indicators, tokens, and the stock gear icon.
- Uses a plugin-owned, loopback-only `/codex-auth` Connection RPC channel.
- Never sends token values to the browser, Harness settings, or logs.
- Installs without modifying the Harness Web shell, apiproxy, or source tree.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or newer compatible `0.1.x` release.
- Node.js `^22.19.0` or `>=24.0.0`.
- The `codex` CLI available on `PATH`.
- Run `codex login` before use, or start login from the GPT Auth card.

## Install from npm (recommended)

The npm package includes prebuilt Host and browser bundles, so no install-time
build permission is required:

```sh
dsh plugin --profile web add dsh-codex-auth
```

Restart `dsh web`, open Settings, and select **GPT Auth**.

## Install a prebuilt release

The release tarball already contains both bundles and needs no install-time
build permission:

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.1.0/dsh-codex-auth-0.1.0.tgz
```

Restart `dsh web`, open Settings, and select **GPT Auth**.

## Install from GitHub source

Install the repository into the profile you run:

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth
```

Git dependencies are built from source by the package's `prepare` script.
pnpm 10+ blocks that script until explicitly allowed, so the first command may
print an `allowBuilds` key and stop. Copy the **exact key printed by dsh** under
`allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml`, then run the command
again. Only grant this permission after reviewing the source.

For a reproducible install, pin a release tag or commit:

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.1.0
```

Restart `dsh web`, open Settings, and select **GPT Auth**.

## Install a tarball

A tarball contains prebuilt Host and browser bundles and requires no install-time
build permission:

```sh
git clone https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.1.0.tgz
```

## Configuration

All plugin-row fields are optional:

| Field | Default | Meaning |
|---|---|---|
| `authJsonPath` | `''` → `$CODEX_HOME`/`~/.codex/auth.json` | Codex auth file |
| `credentialRef` | `CODEX_CHATGPT_TOKEN` | Value-free reference shown by the card |
| `refreshLeadMs` | `300000` | Refresh lead time in milliseconds |
| `codexCommand` | `codex` | CLI command used for login and version probing |
| `displayName` | `OpenAI Codex (chatgpt)` | Provider label in model selectors |

The package includes its own `dsh.bundle` patch, so `dsh plugin` installs and
activates it. Do not also add an `openai-codex` entry under
`llm-pi-ai.providers`; duplicate route registrations conflict.

## Security and limitations

- Token contents never cross the dedicated RPC channel. Status contains only
  availability, auth mode, expiry, refresh time, and a non-secret reference.
- Refresh writes preserve unknown fields and atomically replace the auth file
  with owner-only (`0600`) permissions.
- The RPC channel is restricted to loopback authorities.
- When Codex stores credentials only in the OS keyring, `auth.json` may contain
  no usable token. Set `cli_auth_credentials_store = "file"` in
  `~/.codex/config.toml`, then run `codex login` again.
- A missing login or failed refresh produces a `MISSING_CREDENTIAL` diagnostic;
  a missing Codex CLI disables the login actions.

## Development

```sh
pnpm install
pnpm run check
```

`pnpm run build` emits:

- `lib/index.js` — Host plugin
- `lib/invariant.js` — invariant companion
- `lib/client.js` — loader-compatible browser plugin with inline CSS Modules
- `lib/types/**` — declaration files

The standalone build preset in `build/client-bundle.ts` deliberately carries the
small Web-loader and CSS contract needed by this dual-face plugin; it does not
import files from a DeepSeek Harness checkout.

See [`docs/design.md`](docs/design.md) for the design record and glossary.
