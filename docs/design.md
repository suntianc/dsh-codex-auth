# dsh-codex-auth — design record

Status: **implemented for DSH rc6; Workspace Export remains disabled pending a policy-aware binary workspace-write API**.

The canonical project language lives in [`CONTEXT.md`](../CONTEXT.md). This document records implementation boundaries and the accepted design.

## Purpose

`dsh-codex-auth` is a local, single-user DeepSeek Harness capability bundle. It reuses the ChatGPT login maintained by the official Codex CLI, so Codex remains the login authority and the user does not maintain a second OAuth state.

The bundle provides three independently enabled runtime capabilities from one npm installation:

1. Codex login-state access and the `openai-codex` LLM route;
2. a Codex-backed provider for DSH's stock `web_search` tool;
3. Codex-backed image creation, durable display, reference-image discovery, and workspace export.

The package remains named `dsh-codex-auth`, and the Web settings section remains **GPT Auth** because login gates the other two capabilities. Search and image creation are nevertheless capability operations, not authentication operations.

## Boundaries

- Local machine, one user, loopback-only browser RPC.
- The current Codex account is used; account switching is out of scope.
- The Codex CLI owns login. The plugin neither implements another OAuth flow nor copies the login into Harness credentials.
- The token is not a general OpenAI Platform API credential.
- Remote/multi-user relays, account sharing, audio/video generation, and arbitrary media attachments are out of scope.
- Reference images may come from the current session or the workspace. Direct HTTP(S) reference-image input is out of scope for the first implementation.
- `dsh-codex-auth` and the separately published `dsh-codex` package both own the `openai-codex` route and cannot be installed together.

## Composition

One npm package supplies one client bundle and multiple Host plugin rows:

| Runtime plugin | Responsibility | Primary DSH seams |
|---|---|---|
| Auth/LLM | Codex login status and guidance, request authentication, refresh coordination, `openai-codex` model route | `ctx.llm`, `ctx.codexAuth`, loopback Connection RPC |
| Search | Codex standalone-search transport and normalization | `ctx.web`, `ctx.settings`, current Agent context |
| Image | `generate_image`, `list_images`, attachment persistence, tool presentation, workspace export | `ctx.tools`, `ctx.attachments`, `ctx.fs`, client slots |

Search and Image consume a narrow Host-only auth service. They never read the auth file independently and never receive credentials through browser state. Their enabled state and defaults are separate, live settings even though all rows ship in the same bundle.

The existing Auth/LLM implementation remains the owner of the `openai-codex` route. It reuses `PiAiAdapter` and the installed pi-ai Codex model catalog. The full catalog remains dynamic; image-tool visibility is further restricted by the selected model's declared input modalities.

## Why the Harness credentials seam remains unused

The Codex login is an external, CLI-owned state rather than a Harness-managed secret. The Harness credentials service is not a multi-provider extension registry, and copying the token there would create a second mutable credential state. The adapter and capability plugins therefore resolve request auth through the plugin-owned Host service.

`credentialRef` remains a value-free informational name. It is not resolved through `ctx.credentials`, and Models settings cannot overwrite the Codex login.

## Codex login-state lifecycle

The auth file is `~/.codex/auth.json`, or `$CODEX_HOME/auth.json`. Tokens never enter Harness settings, logs, tool metadata, session events, or browser RPC.

Every authenticated operation follows one coordinator:

1. Acquire the in-process singleflight for the auth path.
2. Acquire the plugin's cross-process lock for DSH consumers.
3. Re-read the auth file after locking; a pre-lock read is only a hint.
4. Reuse a sufficiently fresh access token.
5. When refresh is required, call `https://auth.openai.com/oauth/token` with the Codex OAuth client and current refresh token.
6. Merge successful rotated tokens into the latest document, preserve unknown fields, and atomically write at owner-only permissions.
7. If the authority reports an exhausted/reused token, re-read the file. If Codex CLI or another process has written a newer matching-account login, adopt it instead of forcing a new login.
8. If no usable state can be recovered, return an unconfigured/auth-required error without logging token material.

Atomic replacement prevents torn files; it does **not** prove refresh-token concurrency safety. The official Codex process does not participate in the plugin's lock, so cross-client coordination is best-effort and recovery-oriented rather than an absolute guarantee.

Login buttons continue to spawn the official `codex login` browser or device-code flow. Status RPC remains value-free and loopback-only.

## LLM route

With its default `llmEnabled: true`, the package owns exactly one `openai-codex` adapter route. An installer can set `llmEnabled: false` while retaining the shared Login State coordinator for Search and Image. `PiAiAdapter` continues to handle conversation streaming, ordinary function tools, reasoning replay, usage, cancellation, compaction, and input attachment conversion.

Installed pi-ai `0.82.1` does not model Codex standalone search, Responses `web_search`, or image-generation result items. Search and image creation therefore do not modify or inject payloads into `PiAiAdapter`; they use dedicated capability plugins and the official Codex standalone endpoints.

## Web Search

### Harness integration

Search registers a `WebSearchProvider` through `ctx.web.registerSearchProvider(...)`. It does not register another model-visible `web_search` tool. DSH's stock tool remains responsible for its schema, timeout lifecycle, session events, model-facing rendering, citations, and Web result card.

DSH search-provider selection is deployment-global rather than per Agent. The bundle selects the Codex provider globally, so any model using the stock `web_search` tool may consume the Codex-backed provider.

### Request behavior

The provider posts to the fixed first-party Codex endpoint:

```text
https://chatgpt.com/backend-api/codex/alpha/search
```

For an `openai-codex` caller, the auxiliary request uses the current Agent's Codex model. For another provider, or when no initiating Agent can be resolved, it uses the configured fallback Codex model.

Default search mode is `live`; `cached` and `indexed` remain selectable. Settings also expose context size, fallback model, and maximum output tokens.

### Result behavior

The endpoint guarantees generated output and treats result records as forward-compatible opaque JSON. The provider returns:

- `content` from the generated output;
- deduplicated HTTP(S) source URLs;
- title or snippet only when a recognized response field contains a trustworthy string;
- no fabricated dates, titles, snippets, or follow-up page fetches.

DSH applies its requested maximum-result cap. Search network errors and 5xx responses use cancellable exponential backoff for at most five attempts. HTTP 429 is returned immediately rather than retried automatically.

## Image Creation

### Model-facing tools

The image plugin owns two stable tools:

- `generate_image` — create a new image or edit reference images;
- `list_images` — page through durable session images when older image context is no longer active.

Both are visible only to Agents using an `openai-codex` model that declares image input. Calls are not constrained to literal user wording: a user prompt, model judgment, or installed Skill may invoke them.

### Backend dispatch

`generate_image` presents one domain operation while dispatching to two fixed Codex endpoints:

```text
POST https://chatgpt.com/backend-api/codex/images/generations  # no references
POST https://chatgpt.com/backend-api/codex/images/edits        # one or more references
```

The image model defaults to `gpt-image-2`. The tool accepts:

- required `prompt`;
- up to five reference descriptors;
- `n` from 1 through 10, default 1;
- `size`: `auto`, `1024x1024`, `1536x1024`, or `1024x1536`;
- `quality`: `auto`, `low`, `medium`, or `high`;
- `background`: `auto`, `opaque`, or `transparent`.

Tool arguments may override defaults from the Image Creation settings card.

A reference is explicitly discriminated:

```json
{ "kind": "session", "handle": "image:<attachmentId>" }
{ "kind": "workspace", "path": "assets/reference.png" }
```

Workspace reads go through `ctx.fs`, respect the active workspace and filesystem policy, and are promoted into the attachment store before the remote request. Session handles resolve only when the referenced attachment belongs to the current session.

### Image catalog

Image Handles are stable, model-visible aliases for session-authorized attachment references; users do not manage them directly. Generated tool output places handles next to the corresponding images.

`list_images` returns newest first, defaults to five images, caps one page at ten, and supports a cursor and origin filter. Each item includes its handle, name when available, dimensions, origin, creation sequence, and actual ImageBlock. Returning image content lets the model visually select a reference after compaction rather than guessing from filenames.

### Availability

A clearly identified Free plan marks Image Creation unavailable. An unknown plan remains attemptable; the backend result is authoritative. The plugin never generates a test image merely to probe entitlement.

### Validation and partial success

The image endpoint returns base64 image data. The plugin bounds the encoded and decoded response, verifies each image signature and deployment media policy, and stores valid images through `ctx.attachments.saveImage(...)`.

When a multi-image response contains at least one valid image, valid images are retained and returned with structured warnings for missing or invalid items. The whole call fails only when no valid image remains or the envelope itself is unusable.

Image requests are not automatically retried after dispatch because the server may already have consumed quota and produced an output. Cancellation aborts the client request but has no server-side cancellation protocol.

## Durable display and workspace export

The tool's canonical JSON value carries attachment-reference fields. Its pure output renderer reconstructs standard ImageBlocks, allowing image-capable models to receive the result and the session log to retain authorized attachment references.

The generic DSH tool row currently renders non-text blocks as JSON, so the client plugin registers a keyed `tool.call.toolview` for `generate_image` and `list_images`. The renderer reads attachments through the public session-authorized API, creates bounded Blob URLs, revokes them on lifecycle cleanup, and uses the stock image/gallery components.

The generated-image card provides:

- per-image **Save to workspace**;
- **Save all** for a multi-image result.

A single save proposes `generated-images/<date>-<short-handle>.png` and permits editing. Save-all chooses a destination directory. Existing paths are not overwritten; numeric suffixes are added. All writes occur Host-side through DSH filesystem and permission boundaries. Conversation attachments remain the primary copy.

**Current DSH rc6 constraint:** `ctx.fs` has no binary write operation. This package therefore keeps the durable conversation copy and renders workspace-save controls disabled with an explicit explanation. It does not evade DSH policy with direct `node:fs` writes. Enabling the target export flow requires a policy-aware binary write API in DSH core.

## Settings UI

The independently navigable section keeps the name **GPT Auth** and the stock icon fallback. It contains three cards:

1. **Login** — CLI availability, login state, expiry/refresh facts, and browser/device login actions;
2. **Web Search** — enabled state, global provider state, mode, context size, fallback model, and output budget;
3. **Image Creation** — enabled state, plan eligibility, model-scope note, and default count/size/quality/background.

Search and Image register live settings under the plugin's DSH settings namespace. Both default enabled after installation. Disabling one immediately removes its model capability for current and future Agents without restarting. Logged-out cards are unavailable rather than silently probing the backend.

The UI displays only locally verifiable status. It performs no test search or test generation. Compatibility and private-endpoint disclosures live in repository documentation, not in the settings cards.

## Security and privacy

- Browser RPC and settings never carry bearer, refresh, or ID token values.
- Remote capability endpoints are fixed to `https://chatgpt.com/backend-api/codex`; configuration cannot redirect credentials to another origin.
- Requests use a plugin-owned originator rather than impersonating the official CLI.
- Account identity is resolved from the latest auth document with token-claim fallback; no identity value is accepted from the model.
- Search queries, image prompts, selected handles, and non-secret options are ordinary durable tool inputs. Raw base64 image responses are not logged; durable bytes live in the attachment store.
- Workspace reads/writes and attachment limits remain deployment policy, not plugin bypasses.
- Tokens and backend error bodies are redacted from diagnostics.

The Codex backend is not a public, versioned third-party API contract. The project makes no categorical legal conclusion that this use violates or complies with OpenAI terms. It documents the private, revocable, account-gated nature of the integration and remains intended for personal local use.

## Protocol baseline and compatibility

The standalone request contracts were derived from official Codex `rust-v0.147.0`, commit `be6e8eac029b183056b7e4402879f15d2c85f61b`. That source revision is a maintainer trace and contract-fixture baseline, not a runtime Codex CLI version requirement.

Runtime parsers:

- validate required envelope fields strictly;
- ignore unknown forward-compatible fields;
- preserve bounded, redacted provider diagnostics;
- do not disable features merely because the installed CLI version changes.

The CLI remains required for login guidance and owns the login state; the plugin cooperatively refreshes that same state. Direct Search and Image requests do not invoke a CLI subprocess.

## Failure modes

| Condition | Behavior |
|---|---|
| No usable Codex login | LLM and capability operations fail with auth-required guidance |
| Refresh token reused while another process updated the file | Re-read and adopt the newer same-account login |
| Refresh fails with no recoverable state | Fail closed; guide the user to `codex login` |
| Search provider disabled | Remove/disable the search capability live |
| Search returns output without rich source metadata | Preserve output and valid URLs only |
| Image model lacks image input | Do not expose image tools to that Agent |
| Free plan is known | Mark Image Creation unavailable |
| Plan is unknown | Allow a real user/model-initiated call; surface backend rejection |
| Some generated images are invalid | Return valid images plus structured warnings |
| Every generated image is invalid | Fail the tool call without fabricating output |
| Workspace reference is unreadable or disallowed | Fail before making the remote request |
| `dsh-codex` also owns the route | Fail clearly with mutually exclusive installation guidance |

## Decisions

- [ADR-0001: Reuse the Codex CLI login state](adr/0001-reuse-codex-cli-login-state.md)
- [ADR-0002: Compose Codex capabilities through native DSH seams](adr/0002-compose-codex-capabilities.md)
