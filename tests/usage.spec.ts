/**
 * Host-side tests for the value-free weekly quota snapshot: payload parsing
 * and the CodexAuthService.usage() probe (endpoint, headers, and degradation).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CodexAuthService, usageFromPayload } from '../src/codex-auth-service.ts'

function fakeJwt(expSeconds: number, accountId = 'acct_test', planType?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    exp: expSeconds,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      ...planType === undefined ? {} : { chatgpt_plan_type: planType },
    },
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage'

describe('usageFromPayload', () => {
  it('identifies the weekly window by duration rather than backend position', () => {
    expect(usageFromPayload({
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1786800000 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_after_seconds: 480902, reset_at: 1787204616 },
      },
    })).toEqual({
      planType: 'plus',
      weeklyRemainingPercent: 49,
      weeklyResetAt: new Date(1787204616 * 1000).toISOString(),
    })
  })

  it('clamps the weekly remaining percentage into 0-100 and drops unknown fields', () => {
    const weekly = (usedPercent: unknown) => ({ used_percent: usedPercent, limit_window_seconds: 604800 })
    expect(usageFromPayload({ rate_limit: { secondary_window: weekly(250) } })).toEqual({ weeklyRemainingPercent: 0 })
    expect(usageFromPayload({ rate_limit: { secondary_window: weekly(-5) } })).toEqual({ weeklyRemainingPercent: 100 })
    expect(usageFromPayload({ rate_limit: { secondary_window: weekly('51') } })).toEqual({})
    expect(usageFromPayload({
      rate_limit: { secondary_window: { ...weekly(51), reset_at: Number.MAX_SAFE_INTEGER } },
    })).toEqual({ weeklyRemainingPercent: 49 })
    expect(usageFromPayload(null)).toEqual({})
    expect(usageFromPayload('junk')).toEqual({})
  })
})

describe('CodexAuthService.usage()', () => {
  let dir: string
  let authPath: string
  let contexts: Context[]

  beforeEach(async () => {
    contexts = []
    dir = await mkdtemp(join(tmpdir(), 'codex-auth-usage-'))
    authPath = join(dir, 'auth.json')
  })
  afterEach(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // Each service registers itself on its Context, so every probe needs one.
  function service(fetchImpl: typeof fetch, usageTimeoutMs?: number): CodexAuthService {
    const ctx = new Context()
    contexts.push(ctx)
    return new CodexAuthService(ctx, {
      authJsonPath: authPath,
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      fetchImpl,
      ...usageTimeoutMs === undefined ? {} : { usageTimeoutMs },
    })
  }

  it('probes the ChatGPT usage endpoint with the resolved credential', async () => {
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1'), refresh_token: 'rt-1', account_id: 'acct-1' },
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1786800000 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: 1787204616 },
      },
    }), { status: 200 }))
    const usage = await service(fetchMock).usage()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(WHAM_URL)
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined
    expect(headers?.['authorization']).toContain('Bearer ')
    expect(headers?.['chatgpt-account-id']).toBe('acct-1')
    expect(usage).toEqual({
      planType: 'plus',
      weeklyRemainingPercent: 49,
      weeklyResetAt: new Date(1787204616 * 1000).toISOString(),
    })
  })

  it('bounds a hung usage probe with a Host-owned timeout', async () => {
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'rt-1' },
    }), 'utf8')
    const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))

    const outcome = await Promise.race([
      service(hangingFetch as typeof fetch, 5).usage().then(value => ({ kind: 'usage' as const, value })),
      new Promise<{ kind: 'still-pending' }>(resolve => setTimeout(() => resolve({ kind: 'still-pending' }), 50)),
    ])

    expect(outcome).toEqual({ kind: 'usage', value: {} })
  })

  it('detaches an in-flight usage probe even when its transport ignores abort', async () => {
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'rt-1' },
    }), 'utf8')
    const ctx = new Context()
    let markStarted!: () => void
    let releaseFetch!: () => void
    let usageSignal: AbortSignal | null | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const released = new Promise<void>(resolve => { releaseFetch = resolve })
    const hangingFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      usageSignal = init?.signal
      markStarted()
      await released
      return new Response('{}', { status: 200 })
    })
    const coordinator = new CodexAuthService(ctx, {
      authJsonPath: authPath,
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      fetchImpl: hangingFetch,
    })
    const usage = coordinator.usage()
    await started

    const disposal = ctx.fiber.dispose()
    const outcome = await Promise.race([
      usage.then(value => ({ kind: 'usage' as const, value })),
      new Promise<{ kind: 'still-pending' }>(resolve => setTimeout(() => resolve({ kind: 'still-pending' }), 50)),
    ])
    releaseFetch()
    await disposal
    expect(outcome).toEqual({ kind: 'usage', value: {} })
    expect(usageSignal?.aborted).toBe(true)
  })

  it('detaches while an abort-ignoring response body is stalled', async () => {
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'rt-1' },
    }), 'utf8')
    const ctx = new Context()
    let markBodyStarted!: () => void
    let releaseBody!: () => void
    const bodyStarted = new Promise<void>(resolve => { markBodyStarted = resolve })
    const bodyReleased = new Promise<void>(resolve => { releaseBody = resolve })
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        markBodyStarted()
        await bodyReleased
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    }), { status: 200 }))
    const coordinator = new CodexAuthService(ctx, {
      authJsonPath: authPath,
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      fetchImpl: fetchMock,
    })
    const usage = coordinator.usage()
    await bodyStarted

    const disposal = ctx.fiber.dispose()
    const outcome = await Promise.race([
      usage.then(value => ({ kind: 'usage' as const, value })),
      new Promise<{ kind: 'still-pending' }>(resolve => setTimeout(() => resolve({ kind: 'still-pending' }), 50)),
    ])
    releaseBody()
    await disposal
    expect(outcome).toEqual({ kind: 'usage', value: {} })
  })

  it('answers an empty view when logged out, on upstream errors, and on malformed payloads', async () => {
    const unauthenticated = service(vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(unauthenticated.usage()).resolves.toEqual({})

    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'rt-1' },
    }), 'utf8')

    const upstreamError = service(vi.fn(async () => new Response('nope', { status: 403 })))
    await expect(upstreamError.usage()).resolves.toEqual({})

    const malformed = service(vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(malformed.usage()).resolves.toEqual({})

    const networkFailure = service(vi.fn(async () => { throw new Error('fetch failed') }))
    await expect(networkFailure.usage()).resolves.toEqual({})
  })
})
