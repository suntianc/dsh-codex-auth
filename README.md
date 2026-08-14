# dsh-codex-auth

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Codex Capability Bundle**. It reuses the ChatGPT login maintained by the
official **Codex CLI** (`~/.codex/auth.json`, or `$CODEX_HOME/auth.json`) for:

- the `openai-codex` LLM route;
- a Global Codex Search Provider behind DSH's stock `web_search` tool;
- durable `generate_image` and `list_images` tools for image-capable Codex models;
- one native **GPT Auth** Settings section with Login, Web Search, and Image
  Creation cards.

> **⚠️ Unofficial channel — personal development only.** The private,
> account-gated `chatgpt.com/backend-api` surface is unsupported, revocable, and
> may be rate-limited or changed without notice. Do not rely on it for
> production workloads.

## Features

### Shared Codex Login State

- Uses one Host-only auth coordinator for LLM, Search, and Image operations.
- Reads credentials only at authenticated operation boundaries and refreshes
  through the official OAuth token endpoint before expiry.
- Coalesces concurrent refreshes in-process and uses a cross-process file lock
  with a locked re-read before refresh.
- Adopts externally rotated Codex CLI credentials only when the locally decoded
  account identity still matches.
- Starts the official `codex login` browser or device-code flow.
- Exposes only value-free status over a plugin-owned, loopback-only
  `/codex-auth` Connection RPC channel.

### Web Search

The `codex-search` Host row registers provider ID `codex` through
`@deepseek-ai/dsh-web`. The bundle patch selects it as the deployment-global
Search Provider; a later user profile patch may override that choice. Each
search posts the official standalone request to:

```text
https://chatgpt.com/backend-api/codex/alpha/search
```

For an initiating `openai-codex` Agent, Search uses that Agent's current model;
otherwise it uses the configured fallback model. Results include the generated
output and only deduplicated, valid HTTP(S) source records from recognized
fields—no fabricated titles, dates, snippets, or follow-up page fetches.

Transport and HTTP 5xx failures use cancellable exponential backoff for at most
five attempts. HTTP 429 returns immediately.

Live Search settings:

| Setting | Default | Values |
|---|---:|---|
| Enabled | `true` | on / off |
| Mode | `live` | `live`, `cached`, `indexed` |
| Context size | `medium` | `low`, `medium`, `high` |
| Fallback model | `gpt-5.4` | Codex model ID |
| Maximum output tokens | `2048` | positive integer |

### Image Creation

`generate_image` presents one operation and dispatches to the official Codex
image endpoints:

```text
POST https://chatgpt.com/backend-api/codex/images/generations
POST https://chatgpt.com/backend-api/codex/images/edits
```

It supports a required prompt, up to five explicit reference descriptors, 1–10
outputs, supported size/quality/background controls, and an optional model
override. References are deliberately discriminated:

```json
{ "kind": "session", "handle": "image:<attachmentId>" }
{ "kind": "workspace", "path": "assets/reference.png" }
```

Session handles resolve only when a durable ImageBlock in the current session
authorizes that attachment. Workspace reads stay inside the active workspace,
go through `ctx.fs`, and are promoted into the attachment store before the
remote request. HTTP(S) reference URLs are not accepted.

Generated base64 is bounded, decoded, signature-checked, deployment-policy
validated, and persisted through `ctx.attachments.saveImage(...)`. A
multi-image response keeps valid images and returns structured warnings for bad
items; the whole call fails only when no valid image remains or the response
envelope is unusable. Dispatched image requests are never automatically retried.

`list_images` pages durable session images newest first (default 5, maximum 10),
supports an opaque cursor and origin filter, and returns both stable Image
Handles and actual ImageBlocks so an image-capable model can inspect older
media after compaction.

Image tools are registered in Agent scope only for `openai-codex` models that
declare image input, and execution repeats the same route/model/auth/plan guard.
A locally identified Free plan is marked unavailable. An unknown plan remains
attemptable; the backend is authoritative.

Live Image settings:

| Setting | Default | Values |
|---|---:|---|
| Enabled | `true` | on / off |
| Image model | `gpt-image-2` | image model ID |
| Image count | `1` | 1–10 |
| Size | `auto` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` |
| Quality | `auto` | `auto`, `low`, `medium`, `high` |
| Background | `auto` | `auto`, `opaque`, `transparent` |

The keyed tool result cards use DSH's standard image gallery. A bounded
plugin-owned Blob URL cache reads only through the public session-authorized
attachment API and revokes its URLs on reset, eviction, and plugin teardown.
Generated images remain durable conversation attachments.
DeepSeek Harness `0.1.0-rc.6` does not expose a binary workspace-write API, so
**Save to workspace** is visibly disabled rather than bypassing DSH filesystem
policy with direct Node filesystem access.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or a compatible later `0.1.x` release.
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

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.1.0/dsh-codex-auth-0.1.0.tgz
```

Restart `dsh web`, open Settings, and select **GPT Auth**.

## Install from GitHub source

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth
```

Git dependencies are built by the package's `prepare` script. pnpm 10+ blocks
that script until explicitly allowed, so the first command may print an
`allowBuilds` key and stop. Copy the **exact key printed by dsh** under
`allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml`, then run the command
again. Only grant this permission after reviewing the source.

For a reproducible install, pin a release tag or commit:

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.1.0
```

## Install a tarball

```sh
git clone https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.1.0.tgz
```

## Host configuration

The bundle patch activates three independent Host rows in dependency order:

| Row | Export | Purpose |
|---|---|---|
| `llm-codex-auth` | `dsh-codex-auth` | Shared auth coordinator and LLM route |
| `codex-search` | `dsh-codex-auth/search` | Global Search Provider |
| `codex-image` | `dsh-codex-auth/image` | Agent-scoped image tools |

Auth / LLM row fields are optional. Set `llmEnabled: false` to leave the shared
Login State coordinator available to Search/Image without owning an LLM route:

| Field | Default | Meaning |
|---|---|---|
| `llmEnabled` | `true` | Register the `openai-codex` LLM route |
| `authJsonPath` | `''` → `$CODEX_HOME`/`~/.codex/auth.json` | Codex auth file |
| `credentialRef` | `CODEX_CHATGPT_TOKEN` | Value-free reference shown by the card |
| `refreshLeadMs` | `300000` | Refresh lead time in milliseconds |
| `codexCommand` | `codex` | CLI command used for login and version probing |
| `displayName` | `OpenAI Codex (chatgpt)` | Provider label in model selectors |

Do not also add an `openai-codex` entry under `llm-pi-ai.providers` or install
`dsh-codex`; duplicate route ownership is rejected with an explicit diagnostic.

## Security and limitations

- Token values never enter the browser, settings, logs, session events, tool
  metadata, search requests, or image results. Only Host-side requests receive
  authorization headers.
- Status may include locally decoded account ID and plan claims; these are
  identity/status facts, not credentials.
- Refresh writes preserve unknown fields and atomically replace the auth file
  with owner-only (`0600`) permissions.
- The status/login RPC channel is restricted to loopback authorities.
- Image attachment IDs are not bearer capabilities: session history must contain
  the corresponding durable ImageBlock.
- When Codex stores credentials only in the OS keyring, `auth.json` may contain
  no usable token. Set `cli_auth_credentials_store = "file"` in
  `~/.codex/config.toml`, then run `codex login` again.
- Binary Workspace Export remains unavailable until DSH exposes a policy-aware
  binary write API; conversation persistence is fully supported.

## Development

```sh
pnpm install
pnpm run check
```

`pnpm run build` emits:

- `lib/index.js` — Auth / LLM Host plugin;
- `lib/search.js` — Search Host plugin;
- `lib/image.js` — Image Host plugin;
- `lib/invariant.js` — invariant companion;
- `lib/client.js` — loader-compatible browser plugin with inline CSS Modules;
- `lib/types/**` — declarations.

See [`docs/design.md`](docs/design.md), [`CONTEXT.md`](CONTEXT.md), and the
[architecture decisions](docs/adr/).

## Friendship links

- [L 站](https://linux.do/)
