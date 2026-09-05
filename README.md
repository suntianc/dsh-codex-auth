# dsh-codex-auth

[![npm alpha version](https://img.shields.io/npm/v/dsh-codex-auth/alpha.svg?label=npm%20alpha)](https://www.npmjs.com/package/dsh-codex-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Current alpha release: **v0.3.3-alpha.5**, aligned with DSH `0.1.2-alpha.5`, Cordis `4.0.2`, Schemastery `3.18.2`, and pi-ai `0.84.4`.

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Codex Capability Bundle**. It reuses the ChatGPT login maintained by the
official **Codex CLI** (`~/.codex/auth.json`, or `$CODEX_HOME/auth.json`) for:

- the `openai-codex` LLM route;
- a Global Codex Search Provider behind DSH's stock `web_search` tool;
- durable image generation and editing through `generate_image`, plus the
  model-facing `list_images` catalog;
- resilient weekly Codex usage status;
- one native **GPT Auth** Settings section with Login, LLM Context, Web Search,
  and Image Creation cards; detailed Search/Image controls collapse into compact rows.

> **⚠️ Unofficial channel — personal development only.** The private,
> account-gated `chatgpt.com/backend-api` surface is unsupported, revocable, and
> may be rate-limited or changed without notice. Do not rely on it for
> production workloads.

## v0.3.3-alpha.5 highlights

- Moves the development graph and peer baseline to DSH `0.1.2-alpha.5`, including current Session snapshots, Settings registration, Connection packages, and `ToolCallId`; this repository's lockfile contains no older DSH family.
- Keeps account RPC fail-closed on alpha.5: only an explicit `127.0.0.1` Web bind reaches authentication services.
- Preserves Dual Checkpoint creation, replay, restart/fork durability, and one-shot Turn Continuation on alpha.5.
- Confirms identical final pi-ai payloads across SSE, WebSocket, and automatic fallback, while conservatively keeping deferred-tool `additional_tools` history on Portable checkpoints until that semantic state is part of the Native compatibility digest.

## Features

### Shared Codex Login State

- Uses one Host-only auth coordinator for LLM, Search, and Image operations.
- Resolves credentials through version-bound auth-file snapshots, a short-lived
  in-memory cache, and proactive refresh before expiry.
- Coalesces concurrent refreshes in-process and uses short cross-process lock
  sections before and after OAuth network I/O; a reply is persisted only while
  the account and refresh-token lineage still match.
- Starts the official `codex login` browser or device-code flow.
- Shows connection state plus best-effort weekly remaining balance/reset time.
  The fixed `/backend-api/wham/usage` probe has a ten-second Host deadline and
  identifies the seven-day window by duration rather than response position.
- Sends no token value over the plugin-owned `/codex-auth` Connection RPC
  channel. The real dispatcher is registered only for an explicit
  `127.0.0.1` Web bind; every absent, all-interface, or unknown bind receives
  the same value-free `loopback-required` denial.

### GPT-5.6 and GPT-6 Astra long context

The `openai-codex` route includes GPT-6 Astra (`gpt-6-astra`) even when the
installed pi-ai `0.84.4` catalog does not list it. GPT Auth Settings exposes a
live, default-off **1M context** switch between the Login and capability cards.
It changes the reported context window for `gpt-6-astra`, `gpt-5.6-luna`,
`gpt-5.6-sol`, and `gpt-5.6-terra` from the conservative 272,000-token default
to 1,000,000 tokens. DSH uses that capacity for token pressure and compaction
decisions; no request parameter negotiates capacity with the backend. Requests
beyond 272K may consume account quota faster, backend availability remains
account-dependent, and enabling the switch does not expand history that DSH
already compacted.

### Experimental Dual Checkpoint compaction Adapter

The package exports `dsh-codex-auth/compaction` for an explicitly selected,
user/deployer-authored **custom agent preset**. `CodexCompactionEngine`
subclasses DSH's `BasicCompactionEngine` and wraps its manual, step-pressure,
and provider-confirmed context-overflow entries. Every path first completes
Basic's normal provider-neutral Portable summary, captures that call's final
marker-free Codex payload and already resolved Login State in Host-only memory,
then sends one dedicated Responses v2 request ending in a transient
`compaction_trigger`. A valid opaque result is appended beside the Portable
summary, and Basic commits the resulting **Dual Checkpoint** in its one inherited
transaction. Range selection, pruning, balanced tool pairs, retry caps, durable
markers, surface replacement, and cancellation remain Basic-owned.

Portable success always comes first. A route/model mismatch, image or empty
prefix, unsupported payload, timeout, rate limit, HTTP/protocol error, oversized
state, or conservative shrink failure commits the valid Portable Checkpoint
alone. Portable failure commits no checkpoint. The native request is not
retried. A process-local account/model/endpoint/codec breaker opens for ten
minutes after three transient failures in five minutes, for one hour after a
protocol or unsupported final-payload shape failure, and for a capped
`Retry-After` after HTTP 429. Its half-open state admits one probe. HTTP 401/403
does not count; oversize-state and strict-shrink fallbacks do not count either.
The breaker never disables ordinary inference or Portable compaction. Disposal
aborts active native work and releases request-scoped credentials, payloads,
markers, canonical items, and continuation state.

Debug diagnostics contain only compaction ID, trigger, codec generation, model,
eligibility/status/fallback class, breaker state, duration, item/byte counts,
replay estimate, and usage availability; an authentication rejection recommends
`codex login`. They never include prompts, tools, headers, tokens, turn state,
canonical items, encrypted content, or provider-reported token counts. Reported
native usage may be retained inside the sensitive checkpoint as diagnostic
metadata, but DSH aggregate token accounting continues to use only the Portable
summarization call.

After a successful **inline automatic** native compaction, a nonempty provider
`x-codex-turn-state` response header becomes one process-local **Codex Turn
Continuation**. A read-only `llm/stream` waterfall observes the original
Agent-loop request before Runtime cloning. The continuation is sent only on the
next request with the same session, route, model, Codex account, and Adapter
generation; it expires after 60 seconds and is erased by the first mismatching
eligible request, cancellation/error, route replacement, or plugin disposal.
Portable summaries, session-title/auxiliary calls, direct maintenance,
`compactRegion()`, and manual `/compact` neither consume nor arm it. It never
enters a Session event, checkpoint, UI state, log, error, or telemetry value.

Native generation remains limited to head-anchored current-surface prefixes
whose Portable call uses the same exact `openai-codex` model. Explicit-region
compaction and image-bearing selected prefixes remain Portable-only; images and
other messages after the selected prefix stay in the later DSH tail. Retained
canonical text-only user groups are selected newest-first under the versioned
64,000-token JSON estimate, with one Unicode-safe boundary prefix. Replay
estimation applies Codex's pinned opaque rule—decoded base64 length minus the
650-byte envelope allowance—separately from DSH's provider-neutral pressure
price. The complete custom block is capped at 2 MiB, and Basic still performs
the authoritative strict-shrink check. The extra v2 request adds latency and
consumes Codex quota; its credential-free opaque state is still sensitive
conversation data and is duplicated by alpha.5 in the summary event and replacement
message.

#### Enable and use Dual Checkpoint compaction

Installing the normal Codex Capability Bundle does not activate this Adapter.
`cordis.patch.yml` and DSH's shipped presets continue to select stock Basic
compaction. Opt in through a complete user-owned custom preset:

1. Install the package in the profile that runs DSH (the examples below use
   `web`).
2. Copy DSH's complete Standard preset to a new user preset. Choose a new
   `PRESET_ID`; the commands intentionally refuse to overwrite an existing one:

   ```sh
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   DSH_ROOT="$(dirname "$(dirname "$(realpath "$(command -v dsh)")")")"
   PRESET_ID=codex-dual
   PRESET_DIR="$DSH_HOME/.agent-presets/$PRESET_ID"

   test ! -e "$PRESET_DIR"
   mkdir -p "$DSH_HOME/.agent-presets"
   cp -R "$DSH_ROOT/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard" "$PRESET_DIR"
   ```

3. Give the copy a distinct `name` and `description` in
   `$PRESET_DIR/preset.yml`.
4. In `$PRESET_DIR/agent.cordis.yml`, **replace rather than append** the complete
   `- id: compaction` group with the group from:

   ```text
   $DSH_HOME/profiles/web/node_modules/dsh-codex-auth/
   └── examples/agent-presets/codex-portable/agent.cordis.yml
   ```

   Use only that example's `compaction` group. The example intentionally has no
   persona or tools and is not a replacement for the copied Standard preset.
   The resulting group must contain exactly one
   `dsh-codex-auth/compaction` row with `auto: true`, retain
   `@deepseek-ai/dsh-command-compact` and
   `@deepseek-ai/dsh-compaction-tool-result-pruner`, and contain no
   `@deepseek-ai/dsh-compaction-basic` row. `ctx.compaction` must have one owner.
5. Restart DSH, create a new conversation, select the custom preset, and choose
   an `openai-codex` model. Keep the provider, exact model, account, and explicit
   reasoning setting unchanged when Native replay is required.

With `auto: true`, the custom engine handles both context-pressure compaction
and provider-confirmed context overflow automatically. `/compact` invokes the
same engine manually. Every entry remains Portable-first: an eligible Codex
request adds the Native sibling, while any incompatibility or Native failure
keeps the valid Portable Checkpoint. Stock conversation views intentionally show
the Portable text even when the next compatible provider request replays Native.

This experimental export supports exactly DSH / Basic compaction
`0.1.2-alpha.5` and pi-ai `0.84.4`; mounting it on another pair fails with an
actionable compatibility error. Long Context Mode may change when pressure
compaction runs, but does not change native activation, codec, retention, v2
payload, replay compatibility, or the one-shot turn-continuation contract.
Roll back by selecting a shipped DSH preset. Existing sessions continue through
their Portable text; no profile or conversation migration is required. When DSH
provides a supported provider-native checkpoint Seam, migrate through that Seam
and delete this package's carrier, request side channel, direct transport,
compatibility pin, and custom Basic replacement; keep Portable Checkpoints as
the recovery path.

The repository includes a quota-consuming live harness, but normal tests,
`pnpm run check`, and CI cannot run it. It refuses `CI` and requires both an
existing Codex Login State and an explicit two-variable confirmation:

```sh
DSH_CODEX_NATIVE_LIVE=1 \
DSH_CODEX_NATIVE_LIVE_CONFIRM=I_UNDERSTAND_CODEX_LIVE_QUOTA \
pnpm run test:live:native-compaction
```

It performs real v2 creation, same-process one-shot turn continuation and Native
replay, restart/resume replay, repeated compaction, and redacted-diagnostic checks. Do not run it without
separate authorization to consume live Codex quota; implementation and normal
verification do not execute this boundary.

### Codex Native Checkpoint replay

Ordinary `openai-codex` inference restores a compatible durable **Dual
Checkpoint**. Before pi-ai converts DSH messages, the Host replaces each valid
complete checkpoint message with a request-local marker. The provider payload
hook then replaces that whole marker item at the same position with either the
canonical Codex Native Checkpoint items or one ordinary user item containing
the Portable Checkpoint. Native and Portable representations are never sent
together. The durable block survives JSON persistence, `Session.fromRestore()`,
and `SessionStore.fork()`; replay and later compaction work after restart and in
a fork without rewriting the Session. Before a new trigger, every earlier
compatible checkpoint in the selected prefix expands at its original item
position; an incompatible checkpoint contributes only its Portable message, so
a fresh valid Native checkpoint can still replace that prefix. Basic preserves
all later tail messages and owns repeated-pressure convergence or its bounded
failure.

Native replay requires the checkpoint's schema/codec/retention generations,
provider, exact model, hashed Codex account identity, instructions, tools,
parallel/tool-choice controls, reasoning, text configuration, and service tier
to match the **final effective** Responses request. Pi-ai `0.84.4` may encode
deferred GPT-5.6 tools as an `additional_tools` input item; because that semantic
history is outside this codec's compatibility digest, such a payload
conservatively uses Portable text for both replay and new Native creation. A
composed payload callback may change the modeled controls: replay is re-evaluated
after the callback and selects Native or Portable accordingly. Request IDs, prompt-cache keys, transient
headers, turn state, and Long Context Mode do not affect compatibility. Unknown,
malformed, oversized (over 2 MiB), secret-bearing, mixed, or incompatible state
degrades to Portable text. Generated markers are Host-only and any missing,
duplicate, embedded, leaked, or unconsumed marker fails before network I/O. The
replay converter is pinned to DSH LLM / pi-ai Adapter `0.1.2-alpha.5` and pi-ai
`0.84.4`; another runtime pair uses Portable text instead. Adapter generation
replacement or HMR invalidates process-local replay and turn-continuation state,
while the durable Dual Checkpoint remains unchanged for a later request.

The versioned Host-only codec is exported as
`dsh-codex-auth/native-checkpoint`. It preserves canonical text-only retained-
user Responses items followed by one terminal opaque compaction item as
lossless JSON, but rejects credentials, namespaced account/routing identifiers,
headers, raw turn state, and request-scoped metadata. Only the domain-separated
account hash is durable. The block carries an empty generic-presentation sentinel
so stock conversation and trajectory views display/copy the sibling Portable
text without stringifying opaque state. The credential-free opaque block is
still sensitive ordinary Session data in alpha.5 and may be present in Session
RPC and exports; treat those surfaces accordingly.
The shipped PiAiAdapter and direct DeepSeek Adapter put only Portable text on
their provider wire. Because conversion uses detached request copies, switching
back to a compatible Codex route before another compaction still replays the
retained Native state. Selecting a stock Basic preset likewise needs no Session
migration; incompatible state simply continues through Portable text. Arbitrary
third-party adapters that reject declaration-merged unknown blocks remain an
experimental limitation. Native creation still requires the explicit custom
preset and does not change `cordis.patch.yml`.

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
| Fallback model | `gpt-5.6-terra` | Codex model ID |
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

A successful `generate_image` result displays only the plugin-owned image gallery;
`list_images` is model-facing catalog state and has no user-facing result view. A
bounded plugin-owned Blob URL cache reads only through the public
session-authorized attachment API and revokes its URLs on reset, eviction, and
plugin teardown. Generated images remain durable conversation attachments.
DeepSeek Harness `0.1.2-alpha.5` does not expose a binary workspace-write API, so
no workspace-export action is offered and the plugin never bypasses DSH policy
with direct Node filesystem access.

### ACP image interoperability

An ACP client may send inline PNG, JPEG, WebP, or GIF prompts when the active
`openai-codex` model declares image input. DSH validates and persists those
images before the user message is queued. They therefore enter this plugin's
Image Catalog as ordinary `user` images and can be selected later by Image
Handle as `generate_image` references.

DSH alpha.5 projects durable `tool/call` and `tool/result` events into ACP
`tool_call` and `tool_call_update` messages, respectively. Completed `generate_image` results therefore carry
their image content through that tool update without requiring a later
assistant ImageBlock.

## Requirements

- DeepSeek Harness `0.1.2-alpha.5` (the minimum and tested prerelease baseline); do not mix it with an older rc package family.
- Node.js `^22.19.0` or `>=24.0.0`.
- `pnpm` available on `PATH` (`11.7.0` is the tested project package manager).
- The `codex` CLI available on `PATH`.
- Run `codex login` before use, or start login from the GPT Auth card.

## Install from npm (recommended)

The npm package includes prebuilt Host and browser bundles, so no install-time
build permission is required. Install the alpha.5-aligned release explicitly:

```sh
dsh plugin --profile web add dsh-codex-auth@0.3.3-alpha.5
```

With the Web Host bound explicitly to `127.0.0.1`, restart `dsh web`, open Settings, and select **GPT Auth**.

## Install a prebuilt release

```sh
dsh plugin --profile web add https://github.com/suntianc/dsh-codex-auth/releases/download/v0.3.3-alpha.5/dsh-codex-auth-0.3.3-alpha.5.tgz
```

With the Web Host bound explicitly to `127.0.0.1`, restart `dsh web`, open Settings, and select **GPT Auth**.

## Install from the tagged GitHub source

```sh
dsh plugin --profile web add github:suntianc/dsh-codex-auth#v0.3.3-alpha.5
```

Git dependencies are built by the package's `prepare` script. pnpm 10+ blocks
that script until explicitly allowed, so the first command may print an
`allowBuilds` key and stop. Copy the **exact key printed by dsh** under `allowBuilds` in the
`pnpm-workspace.yaml` path printed by dsh, then run the command again. Only grant this permission after reviewing the source.

## Install a tarball

```sh
git clone --branch v0.3.3-alpha.5 --depth 1 https://github.com/suntianc/dsh-codex-auth.git
cd dsh-codex-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-codex-auth-0.3.3-alpha.5.tgz
```

## Upgrade

Stop the running `dsh web` process and verify that the Host itself is already on
DSH `0.1.2-alpha.5`; upgrade DSH first if it is not. Then install the matching
plugin release and verify the Web profile entry:

```sh
dsh --version # must report 0.1.2-alpha.5
dsh plugin --profile web add dsh-codex-auth@0.3.3-alpha.5
dsh plugin --profile web list
```

After the list reports `dsh-codex-auth@0.3.3-alpha.5`, restart `dsh web` and refresh the
browser.

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
| `longContextEnabled` | `false` | Base value for the live GPT-6 Astra / GPT-5.6 1M context policy; GPT Auth Settings may override it in the `codex-llm` namespace |
| `transport` | `sse` | Streaming transport: `sse`, `websocket`, or `auto` (WebSocket first with SSE fallback). SSE is the default: the WebSocket upgrade is unreliable through common HTTP proxies, and every new conversation pays the connect timeout before `auto` falls back |
| `websocketConnectTimeoutMs` | `5000` | WebSocket connect timeout in milliseconds (used only when `transport` is not `sse`; `0` disables it) |
| `timeoutMs` | `120000` | Request timeout in milliseconds (SSE response-header phase; also the WebSocket message idle interval; `0` disables it) |

Do not also add an `openai-codex` entry under `llm-pi-ai.providers` or install
`dsh-codex`; duplicate route ownership is rejected with an explicit diagnostic.

## Security and limitations

- Token values never enter the browser, settings, logs, session events, tool
  metadata, browser-visible search parameters, or image results. Only Host-side requests receive
  authorization headers.
- Status may include locally decoded account ID and plan claims; these are
  identity/status facts, not credentials.
- Refresh writes preserve unknown fields and atomically replace the auth file
  with owner-only (`0600`) permissions.
- The account RPC dispatcher is enabled only when the public WebServer bind is
  exactly `127.0.0.1`. Missing, `0.0.0.0`, and unknown binds get a fixed,
  value-free `loopback-required` handler that never reaches auth services.
  Alpha.5 has no public per-method or carrier authority fact, so custom
  owner-contained transports are conservatively denied. Client `isLoopback`
  only hides the Settings surface as UX; it is not an authorization boundary.
  In particular, an all-interface Host opened through a localhost URL may show
  the Settings row while every account action is still denied by Host RPC.
- Non-loopback clients omit the GPT Auth Settings and account-RPC bindings but keep the `generate_image` and `list_images` result views registered.
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
- `lib/compaction.js` — experimental custom-preset Dual Checkpoint compaction Adapter;
- `lib/native-checkpoint.js` — versioned Host codec and replay compatibility contract;
- `lib/invariant.js` — invariant companion;
- `lib/client.cjs` — loader-compatible browser plugin with inline CSS Modules;
- `lib/types/**` — declarations.

See [`docs/design.md`](docs/design.md) and the [architecture decisions](docs/adr/).

## Friendship links

- [L 站](https://linux.do/)
