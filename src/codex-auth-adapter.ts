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
 * `PiAiAdapter`; this package supplies the credential, route, and a narrow
 * request-scoped replay, Portable-call capture, and one-shot automatic
 * compaction turn continuity for Native Checkpoints.
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
import type {
  Api, ApiKeyAuth, AuthContext, CredentialStore, Model, Provider, StreamOptions,
} from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  authState, MAX_REFRESH_AGE_MS, mergeRefreshed, needsRefresh, readAuthFile, refreshTooOld,
  refreshTokens, writeAuthFile,
} from './codex-auth.ts'
import type { CodexAuthFile } from './codex-auth.ts'
import type { CodexAuthService } from './codex-auth-service.ts'
import { applyCodexContextPolicy } from './codex-context.ts'
import type { CodexLlmSettings } from './codex-context.ts'
import { CodexNativeCheckpointReplay } from './native-checkpoint-replay.ts'
import type { CodexProviderPayloadCallback } from './native-checkpoint-replay.ts'
import { codexNativeCompactionCoordinator } from './native-compaction.ts'
import {
  codexTurnStateContinuity,
} from './codex-turn-state.ts'
import type { CodexAdapterGeneration } from './codex-turn-state.ts'

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

/** rc1's default maximum encoded image payload for one pi-ai request. */
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum pixel count for one normalized request image. */
export const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** Default maximum encoded byte length for one normalized request image. */
export const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * Request-image limits became resolved-profile fields in DSH rc.2. This local
 * structural extension preserves the rc.1 minimum while letting rc.2 consume
 * the same properties at runtime.
 */
type CodexResolvedPiAiProviderProfile = ResolvedPiAiProviderProfile & {
  requestImagePixelBudget: number
  requestImageMaxBytes: number
}

type CodexProviderTransport = Pick<CodexAuthAdapterOptions, 'fetchImpl' | 'timeoutMs'> & {
  readonly streamIdleTimeoutMs: number
}

/**
 * Codex owns authentication in the Host-side coordinator and injects its token
 * through `resolveApiKey` for each request. Pi-ai's login/storage surface must
 * therefore remain deliberately inert: allowing it to discover or persist a
 * second credential would break the single-source and secret-boundary rules.
 */
export function codexAuthInjection(): { credentials: CredentialStore; authContext: AuthContext } {
  const credentials: CredentialStore = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new LlmError(
        'llm-codex-auth: pi-ai credential persistence is disabled; use the Codex auth coordinator',
        'AUTH_PERSISTENCE_DISABLED',
      )
    },
    delete: async () => {},
  }
  const authContext: AuthContext = {
    env: async () => undefined,
    fileExists: async () => false,
  }
  return { credentials, authContext }
}

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
  /** Live model-capacity settings read for each catalog access. */
  settings: () => CodexLlmSettings
  /** Streaming transport preference (`sse` by default). */
  transport: CodexAuthTransport
  /** WebSocket connect timeout in milliseconds; only used when `transport` is not `sse`. */
  websocketConnectTimeoutMs: number
  /** Request timeout in milliseconds (SSE response-header phase and WebSocket message idle). */
  timeoutMs: number
  /** Existing provider payload hook composed after Native marker restoration. */
  onPayload?: CodexProviderPayloadCallback
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

/** Apply one-shot continuity and both request observers before provider dispatch. */
function prepareCodexStreamOptions<Options extends StreamOptions | undefined>(
  provider: Provider,
  model: Model<Api>,
  options: Options,
  transport: CodexProviderTransport,
  configuredOnPayload: CodexProviderPayloadCallback | undefined,
  replay: CodexNativeCheckpointReplay,
): Options {
  const continued = codexTurnStateContinuity.applyProviderOptions(
    options,
    provider.id,
    model.id,
  )
  noteNativeCompactionRequest(provider, model, continued, transport)
  return withReplayPayload(continued, configuredOnPayload, replay)
}

/**
 * The installed pi-ai catalog provider for the codex route, with the harness
 * api-key method beside native OAuth and request-scoped payload restoration
 * composed around both stream entry points. The catalog provider remains the
 * owner of wire conversion and transport.
 */
function codexProvider(
  displayName: string,
  settings: () => CodexLlmSettings,
  replay: CodexNativeCheckpointReplay,
  transport: CodexProviderTransport,
  configuredOnPayload?: CodexProviderPayloadCallback,
): Provider {
  const base = builtinProviders().find(candidate => candidate.id === CODEX_ROUTE)
  if (base === undefined) {
    throw new Error('llm-codex-auth: the installed pi-ai catalog ships no openai-codex provider')
  }
  return {
    id: base.id,
    name: displayName,
    ...base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl },
    auth: { ...base.auth, apiKey: harnessApiKeyAuth(displayName) },
    getModels: () => applyCodexContextPolicy(base.getModels(), settings()),
    // Delegated rather than copied: the catalog provider stays the receiver,
    // so an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(
      model,
      context,
      prepareCodexStreamOptions(base, model, options, transport, configuredOnPayload, replay),
    ),
    streamSimple: (model, context, options) => base.streamSimple(
      model,
      context,
      prepareCodexStreamOptions(base, model, options, transport, configuredOnPayload, replay),
    ),
  }
}

function noteNativeCompactionRequest(
  provider: Provider,
  model: Model<Api>,
  options: StreamOptions | undefined,
  transport: CodexProviderTransport,
): void {
  const baseUrl = model.baseUrl || provider.baseUrl
  codexNativeCompactionCoordinator.noteProviderRequest({
    provider: provider.id,
    model: model.id,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(model.headers === undefined ? {} : { modelHeaders: model.headers }),
    fetchImpl: transport.fetchImpl,
    timeoutMs: transport.timeoutMs,
    streamIdleTimeoutMs: transport.streamIdleTimeoutMs,
  })
}

function withReplayPayload<
  Options extends { readonly onPayload?: CodexProviderPayloadCallback } | undefined,
>(
  options: Options,
  configured: CodexProviderPayloadCallback | undefined,
  replay: CodexNativeCheckpointReplay,
): Options {
  const previous = composePayloadCallbacks(configured, options?.onPayload)
  const restored = replay.payloadCallback(previous)
  const onPayload = codexNativeCompactionCoordinator.payloadCallback(restored)
  return (onPayload === undefined ? options : { ...options, onPayload }) as Options
}

function composePayloadCallbacks(
  first?: CodexProviderPayloadCallback,
  second?: CodexProviderPayloadCallback,
): CodexProviderPayloadCallback | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return async (payload, model) => {
    const firstResult = await first(payload, model)
    const afterFirst = firstResult === undefined ? payload : firstResult
    const secondResult = await second(afterFirst, model)
    return secondResult === undefined ? afterFirst : secondResult
  }
}

/**
 * The codex-auth LLM adapter: one fixed `openai-codex` profile over the
 * installed pi-ai provider, with the credential resolved from the codex auth
 * file per request.
 */
export class CodexAuthAdapter extends PiAiAdapter {
  private readonly nativeReplay: CodexNativeCheckpointReplay
  private adapterGeneration: CodexAdapterGeneration

  constructor(ctx: Context, options: CodexAuthAdapterOptions) {
    const nativeReplay = new CodexNativeCheckpointReplay()
    const profile: CodexResolvedPiAiProviderProfile = {
      provider: CODEX_ROUTE,
      displayName: options.displayName,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
      requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
      requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
      retryPolicy: resolveRetryPolicy(undefined, `llm-codex-auth: provider "${CODEX_ROUTE}" retryPolicy`),
      piProvider: codexProvider(
        options.displayName,
        options.settings,
        nativeReplay,
        {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        },
        options.onPayload,
      ),
      configuredMaxTokens: new Map(),
      transport: options.transport,
      websocketConnectTimeoutMs: options.websocketConnectTimeoutMs,
      timeoutMs: options.timeoutMs,
    }
    const profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> = new Map([[CODEX_ROUTE, profile]])
    super({
      profiles: () => profiles,
      // This route always supplies its Host-only coordinator token through
      // resolveApiKey. Keep pi-ai's independent login and ambient discovery
      // fail-closed so no second credential path can capture or expose it.
      auth: codexAuthInjection(),
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
        nativeReplay.noteAccount(credential.accountId)
        codexTurnStateContinuity.noteAccount(credential.accountId)
        codexNativeCompactionCoordinator.noteCredential(
          credential.accessToken,
          credential.accountId,
        )
        return credential.accessToken
      },
      resolveAttachments: () => ctx.get('attachments'),
    })
    this.nativeReplay = nativeReplay
    this.adapterGeneration = codexTurnStateContinuity.createGeneration()
    ctx.on('llm/stream', (request, next) =>
      codexTurnStateContinuity.observeLlmStream(request, next))
    ctx.effect(
      () => () => this.retireProcessLocalState(this.adapterGeneration),
      'llm-codex-auth: process-local replay cleanup',
    )
  }

  private retireProcessLocalState(generation: CodexAdapterGeneration): void {
    codexTurnStateContinuity.retireGeneration(generation)
    this.nativeReplay.invalidate()
  }

  /** Discard prepared continuation and Native replay plans on route replacement. */
  replaceRouteGeneration(): void {
    const previous = this.adapterGeneration
    this.adapterGeneration = codexTurnStateContinuity.createGeneration()
    this.retireProcessLocalState(previous)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const generation = this.adapterGeneration
    const replayGeneration = this.nativeReplay.captureGeneration()
    const prepared = await super.prepareCall(provider, model, signal)
    return Object.freeze({
      ...prepared,
      stream: (options: GenerateOptions) => codexTurnStateContinuity.withAdapterGeneration(
        generation,
        () => {
          const preparedOptions = codexNativeCompactionCoordinator.preparePortableCall(options)
          return this.nativeReplay.stream(preparedOptions, prepared.stream, replayGeneration)
        },
      ),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const generation = this.adapterGeneration
    return codexTurnStateContinuity.withAdapterGeneration(generation, () => {
      const preparedOptions = codexNativeCompactionCoordinator.preparePortableCall(options)
      return this.nativeReplay.stream(preparedOptions, detached => super.stream(detached))
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
