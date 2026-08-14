# dsh-codex-auth — design record and glossary

This package is a **personal-development plugin**: it lets the DeepSeek Harness
authenticate an LLM provider through the ChatGPT login the official Codex CLI
already keeps on this machine, so no API key is needed and no second login
state exists.

## Goal and boundaries

- **Goal**: resolve the `CODEX_CHATGPT_TOKEN` credential reference from the
  live codex auth file (with OAuth refresh), guide the user through `codex
  login` when no login exists, and surface login status in the Settings UI.
- **Explicitly out of scope**: a custom LLM adapter (the pi-ai `openai-codex`
  catalog route already implements the chatgpt.com/backend-api Responses
  protocol end to end), any DSH-native OAuth flow (the codex CLI owns the
  login), and account switching (the current codex account is used).
- **Risk acceptance**: the chatgpt.com/backend-api surface is unofficial and
  violates OpenAI ToS; the user accepted this for personal development use
  only. Everything in this package treats the token as revocable.

## How it fits the harness seams

| Seam | Use |
|---|---|
| `ctx.llm` (LlmRuntime) | `registerAdapter(['openai-codex'], adapter)` — the plugin owns the route |
| `LlmAdapter` / `PiAiAdapter` | Reused as-is: one fixed profile over the installed pi-ai `openai-codex` provider, with `resolveApiKey` reading the codex auth file |
| `ctx.codexAuth` (Service) | New service: `status()` (value-free) and `login(mode)` (spawns `codex login`) |
| `ctx.connection.rpc` (`/codex-auth`) | Plugin-owned, loopback-only status/login transport; no core apiproxy extension |
| `dsh.client` (client plugin) | Independently navigable Settings section beside Models; stock gear fallback |
| `ctx.credentials` | Deliberately untouched — single-provider by design; the codex token is not a harness credential |

## Why not the credentials seam

The seam's `ReflectService.store` is keyed per root context by isolation
symbol, so a service can only be **provided once per scope**; a second
registration throws, and `ctx.get('credentials')` (which llm-pi-ai and the
Models page use) always resolves the first registration. There is no
extension point for extra sources. The adapter approach sidesteps this
entirely: the token never enters the harness credential plane, which also
matches the agreed "live-read, never copy" posture better than any seam
shim would.

## Token lifecycle

1. `resolve` reads the auth file per operation (never cached across
   operations — the seam's contract).
2. If the access token (JWT) expires within `refreshLeadMs`, refresh via
   `POST https://auth.openai.com/oauth/token` with the codex CLI's own
   `client_id` (`app_EMoamEEZ73f0CkXaXp7hrann`) and the stored `refresh_token`.
3. The reply is folded into the auth document (unknown fields preserved) and
   written back atomically at 0600, mirroring the codex CLI's own writes.
4. A failed refresh answers **unconfigured**: the request fails with
   `MISSING_CREDENTIAL` and the fix is `codex login` (agreed degradation).
5. The adapter reads the file again on the next operation. The Settings card
   refreshes on mount, connection reset, and an explicit user refresh; the
   dedicated unary channel intentionally does not add a push protocol.

## Security posture

- Tokens never enter harness settings, logs, or the web wire: the status view
  is structurally value-free (`available`, `configured`, `authMode`,
  `codexVersion`, `tokenExpiresAt`, `lastRefreshAt`, `credentialRef`,
  `authFileExists`).
- Writes to the codex auth file use the same `tmp`+rename atomic pattern and
  owner-only mode as the codex CLI; concurrent codex processes are safe
  (whole-file last-writer-wins).
- `set`/`unset` on the codex ref are rejected with guidance, so the Models
  page can never overwrite or shadow the codex-managed login.

## Failure modes

| Condition | Behavior |
|---|---|
| No auth file / no token set | Provider answers unconfigured → `MISSING_CREDENTIAL` |
| Access token expired, refresh fails | Same as above (logged, never surfaced) |
| Refresh token absent | Same as above |
| `codex` CLI missing | `status.available=false`; login buttons disabled; login RPC rejects |
| Malformed auth file | Read throws; provider logs and answers unconfigured; status reports `authFileExists=true, configured=false` |

## Glossary

- **codex 登录态 (codex login state)** — the ChatGPT OAuth token set
  (`tokens{id_token, access_token, refresh_token, account_id}` plus
  `auth_mode`/`last_refresh`) persisted by the codex CLI at
  `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
- **凭证引用 (CredentialRef)** — the env-var-style name configuration carries
  instead of a secret (`CODEX_CHATGPT_TOKEN`); values never enter settings.
- **凭证解析 (credential resolution)** — this plugin resolves the Codex-managed
  login directly inside its LLM adapter; it does not register a
  `CredentialsProvider` or copy the token into Harness storage.
- **ChatGPT 后端通道 (ChatGPT backend channel)** — the unofficial
  `chatgpt.com/backend-api/codex/responses` surface (Responses protocol).
- **登录引导 (login guidance)** — starting the official `codex login` flow
  from the harness; the codex CLI owns the whole OAuth interaction.
- **降级 (degradation)** — answering unconfigured on refresh failure so the
  user is guided to `codex login` instead of silently using a dead token.

## Decisions log

1. **Reuse `codex login` instead of implementing OAuth in DSH** (user
   decision, round 2): smallest surface, single source of truth for
   credentials, official refresh maintenance. Cost: the codex CLI must be
   installed.
2. **Live-read the auth file instead of importing the token** (user decision,
   round 2): no duplicate credential storage; codex refreshes are picked up
   immediately; the file's atomic write pattern makes reads safe.
3. **Plugin-owned Connection RPC for the login card** (implementation
   correction): `/codex-auth` carries value-free status and official CLI login
   startup behind the stock loopback trust fence. The plugin installs directly
   without changing the closed core apiproxy map or Web shell.
4. **Own adapter over the pi-ai codex provider instead of the credentials
   seam** (implementation): the seam cannot be extended from a plugin (single
   provide per scope), so the plugin registers the `openai-codex` route itself
   with a `PiAiAdapter` whose `resolveApiKey` reads the codex auth file. Zero
   core changes; the route's protocol, tools, and catalog are all the
   installed pi-ai implementation.
5. **Expose the full pi-ai codex catalog** (user decision, round 3): models
   are inherited from the installed catalog (`gpt-5.3-codex-spark` …), so
   future model additions surface without config changes.
6. **Keep an independent GPT Auth navigation row with the stock gear** (user
   decision): `settings.section` has no plugin icon field, so the shell's
   documented fallback remains; moving under Plugins was rejected because it
   would remove the independent row.
7. **Ship as a standalone community plugin** (distribution decision): the
   repository owns its Host/browser build preset, explicit published peer
   ranges, `prepare` build, and bundle patch. Consumers never need a sibling
   Harness checkout or a core-source patch.
