/**
 * The LLM adapter half of the codex-auth plugin: registers the `openai-codex`
 * route with a pi-ai-backed adapter that resolves the ChatGPT access token
 * from the live codex auth file (refreshing through the official OAuth
 * endpoint when it is about to expire) instead of through the credentials
 * seam — which is single-provider by design and cannot be extended from a
 * plugin.
 *
 * Everything provider-specific — the chatgpt.com/backend-api Responses
 * protocol, tool calls, SSE/WebSocket transports, the model catalog — is the
 * installed pi-ai `openai-codex` provider, wrapped by the harness's own
 * `PiAiAdapter`; this package only supplies the credential and the route.
 *
 * The route streams over SSE by default: pi-ai prefers a WebSocket connection
 * (`wss://chatgpt.com/backend-api/codex/responses`) with a 15-second connect
 * timeout and a per-session SSE fallback, but the WebSocket upgrade is
 * unreliable through common HTTP proxies, and every new conversation pays the
 * connect timeout again before the fallback engages. Pinning SSE removes that
 * cliff (prompt caching via the `session-id`/`prompt_cache_key` still applies);
 * `auto` and `websocket` remain selectable for networks where the WebSocket
 * works.
 *
 * @module dsh-codex-auth/codex-auth-adapter
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ApiKeyAuth, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  authState, MAX_REFRESH_AGE_MS, mergeRefreshed, needsRefresh, readAuthFile, refreshTooOld,
  refreshTokens, writeAuthFile,
} from './codex-auth.ts'
import type { CodexAuthFile } from './codex-auth.ts'
import type { CodexAuthService } from './codex-auth-service.ts'

/** The provider route this adapter registers. */
export const CODEX_ROUTE = 'openai-codex'

/** Streaming transports pi-ai's codex provider accepts; `sse` is the default here. */
export type CodexAuthTransport = 'auto' | 'sse' | 'websocket'

/**
 * Default streaming transport. SSE is reliable through HTTP proxies; `auto`
 * first tries a WebSocket with a 15-second connect timeout and falls back per
 * conversation, which makes every new conversation's first request slow on
 * networks where the WebSocket upgrade fails.
 */
export const DEFAULT_TRANSPORT: CodexAuthTransport = 'sse'

/** Default WebSocket connect timeout when a non-SSE transport is selected. */
export const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 5_000

/** Default request timeout: the SSE response-header phase, and the WebSocket message idle interval. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/** Provider-idle ceiling for one outstanding stream read, mirroring llm-pi-ai's default. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** Options one adapter instance is constructed with. */
export interface CodexAuthAdapterOptions {
  /** Shared Host-only coordinator used by every authenticated operation. */
  auth: Pick<CodexAuthService, 'credential'>
  /** The codex auth file path (`~/.codex/auth.json` by default); retained for the legacy resolver fixture. */
  authJsonPath: string
  /** The credential reference the status card advertises. */
  credentialRef: CredentialRef
  /** Lead time before access-token expiry that triggers a refresh. */
  refreshLeadMs: number
  /** Injectable fetch for tests. */
  fetchImpl: typeof fetch
  /** Selector label for the route. */
  displayName: string
  /** Streaming transport preference (`sse` by default). */
  transport: CodexAuthTransport
  /** WebSocket connect timeout in milliseconds; only used when `transport` is not `sse`. */
  websocketConnectTimeoutMs: number
  /** Request timeout in milliseconds (SSE response-header phase and WebSocket message idle). */
  timeoutMs: number
}

/**
 * Api-key auth for a harness-authenticated route, mirroring llm-pi-ai's own
 * helper: pi-ai honours a request's `apiKey` override only when the provider
 * declares an api-key method, and the installed codex provider declares OAuth
 * alone — so the method must be added beside it.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/**
 * The installed pi-ai catalog provider for the codex route, with the harness
 * api-key method added beside its native OAuth — the same construction
 * llm-pi-ai uses for a profile that names a credential on an OAuth-only
 * catalog route.
 */
function codexProvider(displayName: string): Provider {
  const base = builtinProviders().find(candidate => candidate.id === CODEX_ROUTE)
  if (base === undefined) {
    throw new Error('llm-codex-auth: the installed pi-ai catalog ships no openai-codex provider')
  }
  return {
    id: base.id,
    name: displayName,
    ...base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl },
    auth: { ...base.auth, apiKey: harnessApiKeyAuth(displayName) },
    getModels: () => base.getModels(),
    // Delegated rather than copied: the catalog provider stays the receiver,
    // so an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * The codex-auth LLM adapter: one fixed `openai-codex` profile over the
 * installed pi-ai provider, with the credential resolved from the codex auth
 * file per request.
 */
export class CodexAuthAdapter extends PiAiAdapter {
  constructor(ctx: Context, options: CodexAuthAdapterOptions) {
    const profile: ResolvedPiAiProviderProfile = {
      provider: CODEX_ROUTE,
      displayName: options.displayName,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, `llm-codex-auth: provider "${CODEX_ROUTE}" retryPolicy`),
      piProvider: codexProvider(options.displayName),
      configuredMaxTokens: new Map(),
      transport: options.transport,
      websocketConnectTimeoutMs: options.websocketConnectTimeoutMs,
      timeoutMs: options.timeoutMs,
    }
    const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[CODEX_ROUTE, profile]])
    super({
      profiles: () => profiles,
      // A missing or dead login answers fail-loud with the seam's coded
      // diagnostic, whose resolution is `codex login` — the agreed
      // degradation instead of letting pi-ai's ambient OAuth discovery run
      // with nothing to discover.
      resolveApiKey: async () => {
        const credential = await options.auth.credential()
        if (credential === undefined) {
          throw new LlmError(
            `llm-codex-auth: no usable ChatGPT login for "${CODEX_ROUTE}"; run "codex login" (or use the`
            + ` "${options.credentialRef}" card on the Settings page) to sign in`,
            'MISSING_CREDENTIAL',
          )
        }
        return credential.accessToken
      },
      resolveAttachments: () => ctx.get('attachments'),
    })
  }
}

/**
 * Resolve the live access token from the codex auth file, refreshing it
 * through the official OAuth endpoint when it is about to expire. A refresh
 * failure (or a missing login) answers `undefined`: the caller decides how to
 * fail, and the logged warning never carries token material.
 * @param options - auth file, expiry lead time, and injectable fetch.
 * @param warn - sink for non-secret diagnostics.
 * @returns the access token, or `undefined` when no usable login exists.
 */
export async function resolveCodexAccessToken(
  options: Pick<CodexAuthAdapterOptions, 'authJsonPath' | 'refreshLeadMs' | 'fetchImpl'>,
  warn: (message: unknown) => void,
): Promise<string | undefined> {
  let file: CodexAuthFile | undefined
  try {
    file = await readAuthFile(options.authJsonPath)
  } catch (error) {
    warn(`failed to read ${options.authJsonPath}; treating the codex login as absent`)
    warn(error)
    return undefined
  }
  if (file === undefined) return undefined
  const state = authState(file)
  if (state.accessToken === undefined) return undefined
  // Refresh when the access token is about to expire, or when the last
  // recorded refresh is older than the codex CLI's own 8-day interval (a
  // long-idle login otherwise fails with 401 on first use).
  if (!needsRefresh(state, options.refreshLeadMs) && !refreshTooOld(file, MAX_REFRESH_AGE_MS)) {
    return state.accessToken
  }
  const refreshToken = file.tokens?.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return undefined
  try {
    const reply = await refreshTokens(refreshToken, options.fetchImpl)
    await writeAuthFile(options.authJsonPath, mergeRefreshed(file, reply))
    return reply.access_token
  } catch (error) {
    warn('token refresh failed; answering unconfigured so the user is guided to `codex login`')
    warn(error)
    return undefined
  }
}
