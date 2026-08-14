/** Browser-safe dedicated Connection RPC contract owned by codex-auth. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Logical channel registered by the plugin's Host half and called by its browser half. */
export const CODEX_AUTH_RPC_CHANNEL = '/codex-auth'

/** One official codex CLI login flow. */
export type CodexAuthLoginMode = 'browser' | 'device'

/** Value-free login state; token values are intentionally absent. */
export interface CodexAuthStatusView {
  available: boolean
  configured: boolean
  authMode?: string
  codexVersion?: string
  tokenExpiresAt?: string
  lastRefreshAt?: string
  credentialRef: string
  authFileExists: boolean
}

/** Browser-safe face consumed by the settings card. */
export interface CodexAuthRpcClient {
  /** Read the value-free codex login state. */
  status(signal?: AbortSignal): Promise<RpcResult<{ status: CodexAuthStatusView }>>
  /** Start one official codex CLI login flow. */
  login(mode: CodexAuthLoginMode, signal?: AbortSignal): Promise<RpcResult<{ started: boolean }>>
}

/** Minimal generic Connection caller required by this plugin. */
export interface CodexAuthConnectionRpc {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}

/** Build the browser face over Connection's plugin-owned unary channel. */
export function createCodexAuthRpcClient(rpc: CodexAuthConnectionRpc): CodexAuthRpcClient {
  return {
    status: async (signal) => {
      const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, 'status', {}, signal)
      if (!result.ok) return result
      const status = parseStatusResult(result.value)
      return status === undefined ? invalidResponse('status') : { ok: true, value: { status } }
    },
    login: async (mode, signal) => {
      const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, 'login', { mode }, signal)
      if (!result.ok) return result
      return isRecord(result.value) && typeof result.value.started === 'boolean'
        ? { ok: true, value: { started: result.value.started } }
        : invalidResponse('login')
    },
  }
}

function parseStatusResult(value: unknown): CodexAuthStatusView | undefined {
  if (!isRecord(value) || !isRecord(value.status)) return undefined
  const status = value.status
  if (
    typeof status.available !== 'boolean'
    || typeof status.configured !== 'boolean'
    || typeof status.credentialRef !== 'string'
    || typeof status.authFileExists !== 'boolean'
  ) return undefined
  for (const key of ['authMode', 'codexVersion', 'tokenExpiresAt', 'lastRefreshAt'] as const) {
    if (status[key] !== undefined && typeof status[key] !== 'string') return undefined
  }
  return {
    available: status.available,
    configured: status.configured,
    ...typeof status.authMode === 'string' ? { authMode: status.authMode } : {},
    ...typeof status.codexVersion === 'string' ? { codexVersion: status.codexVersion } : {},
    ...typeof status.tokenExpiresAt === 'string' ? { tokenExpiresAt: status.tokenExpiresAt } : {},
    ...typeof status.lastRefreshAt === 'string' ? { lastRefreshAt: status.lastRefreshAt } : {},
    credentialRef: status.credentialRef,
    authFileExists: status.authFileExists,
  }
}

function invalidResponse(endpoint: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: `codex-auth: invalid ${endpoint} response from Host`,
      details: {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
