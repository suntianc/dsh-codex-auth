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
import { DEFAULT_REFRESH_LEAD_MS, defaultAuthJsonPath } from './codex-auth.ts'
import { CODEX_ROUTE, CodexAuthAdapter } from './codex-auth-adapter.ts'
import { CodexAuthService } from './codex-auth-service.ts'
import { installEnvHttpProxy } from './env-proxy.ts'
import { CODEX_AUTH_RPC_CHANNEL, handleCodexAuthRpc } from './rpc.ts'

export const name = 'llm-codex-auth'
export const inject = ['llm']

/** Plugin configuration; every field has a default, so a bare row mounts the plugin. */
export interface Config {
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
}

export const Config: z<Config> = z.object({
  authJsonPath: z.string().default(''),
  credentialRef: z.string().default('CODEX_CHATGPT_TOKEN'),
  refreshLeadMs: z.number().min(0).default(DEFAULT_REFRESH_LEAD_MS),
  codexCommand: z.string().default('codex'),
  displayName: z.string().default('OpenAI Codex (chatgpt)'),
})

/** Mount the codex-auth adapter and service. */
export function apply(ctx: Context, config: Config): void {
  // Without this, Node's fetch ignores the machine's HTTP proxy env and the
  // chatgpt backend is unreachable on proxied networks (connect timeout).
  installEnvHttpProxy((message) => { ctx.logger.warn(String(message)) })
  const credentialReference: CredentialRef = credentialRef(config.credentialRef)
  const authJsonPath = config.authJsonPath.length > 0 ? config.authJsonPath : defaultAuthJsonPath()
  ctx.llm.registerAdapter([CODEX_ROUTE], new CodexAuthAdapter(ctx, {
    authJsonPath,
    credentialRef: credentialReference,
    refreshLeadMs: config.refreshLeadMs,
    fetchImpl: fetch,
    displayName: config.displayName,
  }))
  const service = new CodexAuthService(ctx, {
    authJsonPath,
    codexCommand: config.codexCommand,
    credentialRef: credentialReference,
  })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      CODEX_AUTH_RPC_CHANNEL,
      (endpoint, payload) => handleCodexAuthRpc(service, endpoint, payload),
      { authority: 'loopback' },
    )
  })
  ctx.logger.info('llm-codex-auth: route %s serving ChatGPT login from %s', CODEX_ROUTE, authJsonPath)
}
