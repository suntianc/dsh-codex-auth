/**
 * Codex-auth login plugin, host half. Mounts:
 *
 * - an LLM adapter owning the `openai-codex` provider route, wrapping the
 *   installed pi-ai codex provider (chatgpt.com/backend-api, Responses
 *   protocol) with the ChatGPT access token resolved live from the codex CLI's
 *   auth file;
 * - the `codexAuth` service: login status (value-free) and login-flow startup
 *   for the web surface.
 *
 * The credentials seam is deliberately untouched: it is single-provider by
 * design, and the codex token is not a key the harness should store or
 * describe — it lives in the codex CLI's own file, refreshed by this plugin
 * through the official OAuth endpoint.
 *
 * @module dsh-codex-auth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { DEFAULT_REFRESH_LEAD_MS, defaultAuthJsonPath } from './codex-auth.ts'
import {
  CODEX_ROUTE, CodexAuthAdapter, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_TRANSPORT,
  DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
} from './codex-auth-adapter.ts'
import type { CodexAuthTransport } from './codex-auth-adapter.ts'
import { CodexAuthService } from './codex-auth-service.ts'
import {
  CODEX_LLM_SETTINGS_NAMESPACE, CodexLlmSettingsConfig,
} from './codex-context.ts'
import type { CodexLlmSettings } from './codex-context.ts'
import { installEnvHttpProxy } from './env-proxy.ts'
import { createLoopbackRpcGuard } from './loopback-rpc.ts'
import { CODEX_AUTH_RPC_CHANNEL, handleCodexAuthRpc } from './rpc.ts'

export const name = 'llm-codex-auth'
export const inject = ['llm']

/** Plugin configuration; every field has a default, so a bare row mounts the plugin. */
export interface Config {
  /** Whether this row owns the openai-codex LLM route; auth coordination remains available when false. */
  llmEnabled: boolean
  /** Codex auth file path; empty (default) resolves `$CODEX_HOME` or `~/.codex/auth.json`. */
  authJsonPath: string
  /** Credential reference advertised by the status card. */
  credentialRef: string
  /** Lead time before access-token expiry that triggers a refresh. */
  refreshLeadMs: number
  /** The codex CLI command used for login and version probing. */
  codexCommand: string
  /** Selector label for the provider route. */
  displayName: string
  /** Opt into the one-million-token context budget for supported GPT-5.6 models. */
  longContextEnabled: boolean
  /** Streaming transport for the route; SSE by default because the WebSocket upgrade is unreliable through common HTTP proxies. */
  transport: CodexAuthTransport
  /** WebSocket connect timeout in milliseconds; only used when `transport` is not `sse`; zero disables it. */
  websocketConnectTimeoutMs: number
  /** Request timeout in milliseconds (SSE response-header phase and WebSocket message idle); zero disables it. */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  llmEnabled: z.boolean().default(true),
  authJsonPath: z.string().default(''),
  credentialRef: z.string().default('CODEX_CHATGPT_TOKEN'),
  refreshLeadMs: z.number().min(0).default(DEFAULT_REFRESH_LEAD_MS),
  codexCommand: z.string().default('codex'),
  displayName: z.string().default('OpenAI Codex (chatgpt)'),
  longContextEnabled: z.boolean().default(false),
  transport: z.union([z.const('auto'), z.const('sse'), z.const('websocket')]).default(DEFAULT_TRANSPORT),
  websocketConnectTimeoutMs: z.natural().default(DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS),
  timeoutMs: z.natural().default(DEFAULT_REQUEST_TIMEOUT_MS),
})

/** Mount the codex-auth adapter and service. */
export function apply(ctx: Context, config: Config): void {
  // Without this, Node's fetch ignores the machine's HTTP proxy env and the
  // chatgpt backend is unreachable on proxied networks (connect timeout).
  installEnvHttpProxy((message) => { ctx.logger.warn(String(message)) })
  const credentialReference: CredentialRef = credentialRef(config.credentialRef)
  const authJsonPath = config.authJsonPath.length > 0 ? config.authJsonPath : defaultAuthJsonPath()
  const service = new CodexAuthService(ctx, {
    authJsonPath,
    codexCommand: config.codexCommand,
    credentialRef: credentialReference,
    refreshLeadMs: config.refreshLeadMs,
    fetchImpl: fetch,
  })
  const settingsEntry: CodexLlmSettings = { longContextEnabled: config.longContextEnabled }
  let currentSettings = (): CodexLlmSettings => settingsEntry
  let announceModelPolicyChange = (): void => {}
  if (config.llmEnabled) {
    if (ctx.llm.listProviders().some(provider => provider.id === CODEX_ROUTE)) {
      throw new Error(
        'dsh-codex-auth cannot own the "openai-codex" route because another plugin already registered it; '
        + 'dsh-codex-auth and dsh-codex are mutually exclusive, so uninstall or disable one bundle',
      )
    }
    const adapter = new CodexAuthAdapter(ctx, {
      auth: service,
      authJsonPath,
      credentialRef: credentialReference,
      refreshLeadMs: config.refreshLeadMs,
      fetchImpl: fetch,
      displayName: config.displayName,
      settings: () => currentSettings(),
      transport: config.transport,
      websocketConnectTimeoutMs: config.websocketConnectTimeoutMs,
      timeoutMs: config.timeoutMs,
    })
    const registration = ctx.llm.registerAdapter([CODEX_ROUTE], adapter)
    announceModelPolicyChange = () => {
      adapter.replaceRouteGeneration()
      registration.replace([CODEX_ROUTE])
    }
  }
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, CODEX_LLM_SETTINGS_NAMESPACE, CodexLlmSettingsConfig, settingsEntry, {
      setSource: source => { currentSettings = source },
      onChange: announceModelPolicyChange,
    })
  })
  ctx.inject(['connection'], connectionCtx => {
    const guard = createLoopbackRpcGuard(
      connectionCtx.get('webServer')?.host,
      (endpoint, payload, signal) => handleCodexAuthRpc(service, endpoint, payload, signal),
    )
    if (guard.mode === 'blocked') {
      connectionCtx.logger.warn('llm-codex-auth: account RPC is disabled because the WebServer is not loopback-bound')
    }
    return connectionCtx.connection.rpc.handle(CODEX_AUTH_RPC_CHANNEL, guard.handler)
  })
  if (config.llmEnabled) {
    ctx.logger.info(
      'llm-codex-auth: route %s serving ChatGPT login from %s (transport %s, ws-connect %sms, request timeout %sms)',
      CODEX_ROUTE, authJsonPath, config.transport, config.websocketConnectTimeoutMs, config.timeoutMs,
    )
  } else {
    ctx.logger.info('llm-codex-auth: shared Login State active at %s; LLM route disabled', authJsonPath)
  }
}
