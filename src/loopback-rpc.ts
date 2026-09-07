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
 * Decide the shared account-control activation mode from the public WebServer
 * bind. Only an explicitly loopback-bound Web service is enabled; a missing,
 * non-loopback, or unknown bind is blocked because absence of WebServer is not
 * proof of an owned carrier.
 *
 * This is a Host activation policy, not a per-request source check. DSH
 * 0.1.2-alpha.5 exposes no public method-level or carrier authority context.
 */
export function loopbackMode(webServerHost: string | undefined): LoopbackRpcMode {
  return webServerHost === '127.0.0.1' ? 'enabled' : 'blocked'
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
