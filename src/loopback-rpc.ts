/** Static fail-closed guard for account RPC after DSH removed per-channel authority. */

import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

export type LoopbackRpcMode = 'enabled' | 'blocked'

export interface LoopbackRpcGuard {
  /** Why the guarded handler is available or blocked for this Host composition. */
  readonly mode: LoopbackRpcMode
  /** Handler safe to register on the public Connection service. */
  readonly handler: ConnectionRpcHandler
}

const LOOPBACK_REQUIRED_MESSAGE = 'Codex account controls require a loopback-bound DSH Host'

/**
 * Select the real RPC dispatcher only for an explicitly loopback-bound Web
 * service. A missing, non-loopback, or unknown bind gets a value-free inert
 * dispatcher because absence of WebServer is not proof of an owned carrier.
 *
 * This is a Host activation policy, not a per-request source check. DSH
 * 0.1.2-alpha.5 exposes no public method-level or carrier authority context.
 */
export function createLoopbackRpcGuard(
  webServerHost: string | undefined,
  delegate: ConnectionRpcHandler,
): LoopbackRpcGuard {
  if (webServerHost === '127.0.0.1') return { mode: 'enabled', handler: delegate }
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
