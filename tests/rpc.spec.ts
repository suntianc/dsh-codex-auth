/** Dedicated codex-auth Connection RPC contract tests. */
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_AUTH_RPC_CHANNEL, createCodexAuthRpcClient, type CodexAuthStatusView,
} from '../src/rpc-contract.ts'
import { handleCodexAuthRpc } from '../src/rpc.ts'

const STATUS: CodexAuthStatusView = {
  available: true,
  configured: true,
  authMode: 'chatgpt',
  codexVersion: 'codex-cli 0.147.0',
  accountId: 'acct-1',
  planType: 'plus',
  credentialRef: 'CODEX_CHATGPT_TOKEN',
  authFileExists: true,
}

const USAGE = {
  planType: 'plus',
  weeklyRemainingPercent: 49,
  weeklyResetAt: '2026-08-20T12:00:00.000Z',
}

describe('dedicated codex-auth RPC', () => {
  it('dispatches value-free status and login requests', async () => {
    const service = {
      status: vi.fn(() => Promise.resolve(STATUS)),
      usage: vi.fn(() => Promise.resolve(USAGE)),
      login: vi.fn(() => Promise.resolve({ started: true })),
    }

    expect(await handleCodexAuthRpc(service, 'status', {})).toEqual({
      ok: true,
      value: { status: STATUS },
    })
    expect(await handleCodexAuthRpc(service, 'usage', {})).toEqual({
      ok: true,
      value: { usage: USAGE },
    })
    expect(service.usage).toHaveBeenCalledTimes(1)
    expect(await handleCodexAuthRpc(service, 'login', { mode: 'device' })).toEqual({
      ok: true,
      value: { started: true },
    })
    expect(service.login).toHaveBeenCalledWith('device')
    expect(JSON.stringify(await handleCodexAuthRpc(service, 'status', {}))).not.toContain('token-value')
  })

  it('propagates caller cancellation to the Host usage probe', async () => {
    const controller = new AbortController()
    const usage = vi.fn(async (_signal?: AbortSignal) => ({}))
    const service = { status: vi.fn(), usage, login: vi.fn() }

    await expect(handleCodexAuthRpc(service, 'usage', {}, controller.signal)).resolves.toEqual({
      ok: true,
      value: { usage: {} },
    })
    expect(usage).toHaveBeenCalledWith(controller.signal)
  })

  it('rejects malformed payloads and unknown endpoints', async () => {
    const service = { status: vi.fn(), usage: vi.fn(), login: vi.fn() }
    for (const [endpoint, payload] of [
      ['status', { extra: true }],
      ['usage', { extra: true }],
      ['login', {}],
      ['login', { mode: 'browser', extra: true }],
      ['unknown', {}],
    ] as const) {
      const result = await handleCodexAuthRpc(service, endpoint, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    }
    expect(service.status).not.toHaveBeenCalled()
    expect(service.usage).not.toHaveBeenCalled()
    expect(service.login).not.toHaveBeenCalled()
  })

  it('folds service failures into a structured RPC error', async () => {
    const service = {
      status: vi.fn(() => Promise.reject(new Error('auth file unreadable'))),
      usage: vi.fn(() => Promise.reject(new Error('usage probe failed'))),
      login: vi.fn(() => Promise.reject(new Error('codex not on PATH'))),
    }
    await expect(handleCodexAuthRpc(service, 'status', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'auth file unreadable' },
    })
    await expect(handleCodexAuthRpc(service, 'usage', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'usage probe failed' },
    })
    await expect(handleCodexAuthRpc(service, 'login', { mode: 'browser' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'codex not on PATH' },
    })
  })

  it('calls the plugin-owned channel without an apiproxy domain and validates replies', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { status: STATUS } })
      .mockResolvedValueOnce({ ok: true as const, value: { usage: USAGE } })
      .mockResolvedValueOnce({ ok: true as const, value: { malformed: true } })
      .mockResolvedValueOnce({ ok: true as const, value: { usage: { weeklyRemainingPercent: 500 } } })
    const client = createCodexAuthRpcClient({ call })

    await expect(client.status()).resolves.toEqual({ ok: true, value: { status: STATUS } })
    expect(call).toHaveBeenCalledWith(CODEX_AUTH_RPC_CHANNEL, 'status', {}, undefined)
    await expect(client.usage()).resolves.toEqual({ ok: true, value: { usage: USAGE } })
    expect(call).toHaveBeenCalledWith(CODEX_AUTH_RPC_CHANNEL, 'usage', {}, undefined)
    const malformed = await client.login('device')
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.error.code).toBe('internal')
      expect(malformed.error.message).toContain('invalid login response')
    }
    const outOfRange = await client.usage()
    expect(outOfRange.ok).toBe(false)
    if (!outOfRange.ok) expect(outOfRange.error.message).toContain('invalid usage response')
  })
})
