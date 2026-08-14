/** Host dispatcher for the codex-auth plugin's dedicated Connection RPC. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CodexAuthService } from './codex-auth-service.ts'
import type { CodexAuthLoginMode } from './rpc-contract.ts'
export { CODEX_AUTH_RPC_CHANNEL } from './rpc-contract.ts'

/** Dispatch a decoded Host request without ever exposing token material. */
export async function handleCodexAuthRpc(
  service: Pick<CodexAuthService, 'status' | 'usage' | 'login'>,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<RpcResult<unknown>> {
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
