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
  /** Locally decoded ChatGPT account claim; never a credential. */
  accountId?: string
  /** Locally decoded ChatGPT plan claim, when present; never remotely probed. */
  planType?: string
  credentialRef: string
  authFileExists: boolean
}

/** Value-free weekly quota snapshot for the settings login block. */
export interface CodexUsageView {
  /** Backend-reported plan claim for the account; absent when unknown. */
  planType?: string
  /** Remaining percentage (0-100) of the seven-day usage window; absent when unknown. */
  weeklyRemainingPercent?: number
  /** ISO timestamp of the seven-day usage window's next reset; absent when unknown. */
  weeklyResetAt?: string
}

/** Browser-safe face consumed by the settings card. */
export interface CodexAuthRpcClient {
  /** Read the value-free codex login state. */
  status(signal?: AbortSignal): Promise<RpcResult<{ status: CodexAuthStatusView }>>
  /** Read the value-free weekly quota snapshot from the ChatGPT backend. */
  usage(signal?: AbortSignal): Promise<RpcResult<{ usage: CodexUsageView }>>
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
    usage: async (signal) => {
      const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, 'usage', {}, signal)
      if (!result.ok) return result
      const usage = parseUsageResult(result.value)
      return usage === undefined ? invalidResponse('usage') : { ok: true, value: { usage } }
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
  for (const key of ['authMode', 'codexVersion', 'tokenExpiresAt', 'lastRefreshAt', 'accountId', 'planType'] as const) {
    if (status[key] !== undefined && typeof status[key] !== 'string') return undefined
  }
  return {
    available: status.available,
    configured: status.configured,
    ...typeof status.authMode === 'string' ? { authMode: status.authMode } : {},
    ...typeof status.codexVersion === 'string' ? { codexVersion: status.codexVersion } : {},
    ...typeof status.tokenExpiresAt === 'string' ? { tokenExpiresAt: status.tokenExpiresAt } : {},
    ...typeof status.lastRefreshAt === 'string' ? { lastRefreshAt: status.lastRefreshAt } : {},
    ...typeof status.accountId === 'string' ? { accountId: status.accountId } : {},
    ...typeof status.planType === 'string' ? { planType: status.planType } : {},
    credentialRef: status.credentialRef,
    authFileExists: status.authFileExists,
  }
}

function parseUsageResult(value: unknown): CodexUsageView | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined
  const usage = value.usage
  if (usage.planType !== undefined && typeof usage.planType !== 'string') return undefined
  if (usage.weeklyResetAt !== undefined && typeof usage.weeklyResetAt !== 'string') return undefined
  if (
    usage.weeklyRemainingPercent !== undefined
    && (!Number.isSafeInteger(usage.weeklyRemainingPercent)
      || (usage.weeklyRemainingPercent as number) < 0
      || (usage.weeklyRemainingPercent as number) > 100)
  ) return undefined
  return {
    ...typeof usage.planType === 'string' ? { planType: usage.planType } : {},
    ...typeof usage.weeklyRemainingPercent === 'number' ? { weeklyRemainingPercent: usage.weeklyRemainingPercent } : {},
    ...typeof usage.weeklyResetAt === 'string' ? { weeklyResetAt: usage.weeklyResetAt } : {},
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
