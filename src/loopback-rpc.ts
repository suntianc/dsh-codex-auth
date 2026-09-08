/** Static fail-closed guard for account RPC after DSH removed per-channel authority. */

import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

export type LoopbackRpcMode = 'enabled' | 'blocked'

export interface LoopbackRpcGuard {
  /** Why the guarded handler is available or blocked for this Host composition. */
  readonly mode: LoopbackRpcMode
  /** Handler safe to register on the public Connection service. */
  readonly handler: ConnectionRpcHandler
}

export const LOOPBACK_REQUIRED_MESSAGE = 'Codex account controls require a loopback-bound DSH Host'

/**
 * Decide the account RPC activation from the public WebServer bind. Only an
 * explicitly loopback-bound Web service is enabled; a missing, non-loopback,
 * or unknown bind is blocked because absence of WebServer is not proof of an
 * owned carrier.
 *
 * This is a Host activation policy, not a per-request source check. DSH
 * 0.1.2-alpha.5 exposes no public method-level or carrier authority context.
 */
export function loopbackMode(webServerHost: string | undefined): LoopbackRpcMode {
  return webServerHost === '127.0.0.1' ? 'enabled' : 'blocked'
}

/** Command-entry denial shown when the Host exposes the commands seam beyond loopback. */
export const ACCOUNT_COMMAND_DENIED_MESSAGE = 'Codex account commands require a local DSH Host (no WebServer or 127.0.0.1-bound)'

/**
 * Decide slash-command activation for one Host composition. The account
 * command is the local-terminal login entry point: a composition with no
 * WebServer can only dispatch through local UI adapters, and a loopback-bound
 * WebServer is the same machine, so both are enabled. Any other WebServer bind
 * exposes the shared commands seam to remote callers, and DSH 0.1.2-alpha.5
 * command invocations carry no caller/carrier authority with which to exempt
 * the local terminal, so those compositions fail closed for every caller.
 *
 * This is a Host activation policy, not a per-request source check.
 */
export function commandAccountMode(webServer: { readonly host?: string } | undefined): LoopbackRpcMode {
  if (webServer === undefined) return 'enabled'
  return loopbackMode(webServer.host)
}

/**
 * Select the real RPC dispatcher only for an explicitly loopback-bound Web
 * service; any other composition registers a value-free inert dispatcher that
 * never calls the delegate.
 */
export function createLoopbackRpcGuard(
  webServerHost: string | undefined,
  delegate: ConnectionRpcHandler,
): LoopbackRpcGuard {
  if (loopbackMode(webServerHost) === 'blocked') {
    return {
      mode: 'blocked',
      handler: async (): Promise<ConnectionRpcResult<never>> => ({
        ok: false,
        error: {
          code: 'loopback-required',
          message: LOOPBACK_REQUIRED_MESSAGE,
          details: {},
        },
      }),
    }
  }
  return { mode: 'enabled', handler: delegate }
}
