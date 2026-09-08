import { describe, expect, it, vi } from 'vitest'
import { commandAccountMode, createLoopbackRpcGuard } from '../src/loopback-rpc.ts'

const signal = new AbortController().signal

function success(value: unknown) {
  return Promise.resolve({ ok: true as const, value })
}

describe('commandAccountMode', () => {
  it('enables the account command on a terminal composition without a WebServer', () => {
    expect(commandAccountMode(undefined)).toBe('enabled')
  })

  it('enables the account command on a loopback-bound Web composition', () => {
    expect(commandAccountMode({ host: '127.0.0.1' })).toBe('enabled')
  })

  it.each(['0.0.0.0', '::', 'unknown-host'])('blocks the account command on the public bind %s', bindHost => {
    expect(commandAccountMode({ host: bindHost })).toBe('blocked')
  })

  it('blocks the account command when a WebServer composes no published bind', () => {
    expect(commandAccountMode({})).toBe('blocked')
  })
})

describe('alpha.5 loopback RPC guard', () => {
  it('keeps the real handler on the explicit loopback Web bind', async () => {
    const delegate = vi.fn((_endpoint: string, payload: unknown) => success(payload))
    const guard = createLoopbackRpcGuard('127.0.0.1', delegate)

    expect(guard.mode).toBe('enabled')
    await expect(guard.handler('status', { value: 1 }, signal)).resolves.toEqual({
      ok: true,
      value: { value: 1 },
    })
    expect(delegate).toHaveBeenCalledWith('status', { value: 1 }, signal)
  })

  it('fails closed when WebServer is absent because carrier ownership is unproven', async () => {
    const delegate = vi.fn((_endpoint: string, payload: unknown) => success(payload))
    const guard = createLoopbackRpcGuard(undefined, delegate)

    expect(guard.mode).toBe('blocked')
    await expect(guard.handler('status', {}, signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'loopback-required',
        message: 'Codex account controls require a loopback-bound DSH Host',
        details: {},
      },
    })
    expect(delegate).not.toHaveBeenCalled()
  })

  it.each(['0.0.0.0', 'unknown-host'])('fails closed on the non-loopback or unknown bind %s', async bindHost => {
    const delegate = vi.fn((_endpoint: string, payload: unknown) => success(payload))
    const guard = createLoopbackRpcGuard(bindHost, delegate)

    expect(guard.mode).toBe('blocked')
    for (const endpoint of ['status', 'usage', 'login', 'unknown']) {
      const result = await guard.handler(endpoint, { accessToken: 'forbidden-value' }, signal)
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'loopback-required',
          message: 'Codex account controls require a loopback-bound DSH Host',
          details: {},
        },
      })
      expect(JSON.stringify(result)).not.toContain('forbidden-value')
    }
    expect(delegate).not.toHaveBeenCalled()
  })
})
