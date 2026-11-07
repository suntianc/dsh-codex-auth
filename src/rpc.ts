/** Host dispatcher for the codex-auth plugin's dedicated Connection RPC. */

import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import type { CodexAuthService } from './codex-auth-service.ts'
import type { CodexAuthLoginMode } from './rpc-contract.ts'
import type { CodexFastModeView } from './rpc-contract.ts'
export { CODEX_AUTH_RPC_CHANNEL, CODEX_AUTH_RPC_NAMESPACE } from './rpc-contract.ts'

/** Dispatch a decoded Host request without ever exposing token material. */
export async function handleCodexAuthRpc(
  service: Pick<CodexAuthService, 'status' | 'usage' | 'login'>,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
  fastMode?: (sessionId: string, enabled?: boolean) => Promise<CodexFastModeView>,
): Promise<RpcResult<unknown>> {
  if (endpoint === 'fast-mode') {
    if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0
      || payload.sessionId.length > 512 || (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')
      || Object.keys(payload).some(key => key !== 'sessionId' && key !== 'enabled')) return badRequest('fast-mode expects { sessionId, enabled?: boolean }')
    if (fastMode === undefined) return badRequest('Session Fast mode is unavailable')
    try {
      return { ok: true, value: { fastMode: await fastMode(payload.sessionId, payload.enabled as boolean | undefined) } }
    } catch (error) { return internalError(error) }
  }
  if (endpoint === 'status') {
    if (!isRecord(payload) || Object.keys(payload).length !== 0) return badRequest('status expects an empty payload')
    try {
      return { ok: true, value: { status: await service.status() } }
    } catch (error) {
      return internalError(error)
    }
  }
  if (endpoint === 'usage') {
    if (!isRecord(payload) || Object.keys(payload).length !== 0) return badRequest('usage expects an empty payload')
    try {
      return { ok: true, value: { usage: await service.usage(signal) } }
    } catch (error) {
      return internalError(error)
    }
  }
  if (endpoint === 'login') {
    if (!isRecord(payload) || !isLoginMode(payload.mode) || Object.keys(payload).some(key => key !== 'mode')) {
      return badRequest('login expects { mode: "browser" | "device" }')
    }
    try {
      return { ok: true, value: await service.login(payload.mode) }
    } catch (error) {
      return internalError(error)
    }
  }
  return badRequest(`unknown codex-auth endpoint ${JSON.stringify(endpoint)}`)
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoginMode(value: unknown): value is CodexAuthLoginMode {
  return value === 'browser' || value === 'device'
}
