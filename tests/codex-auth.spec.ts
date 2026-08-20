/**
 * Host-side tests for the codex-auth plugin: token decoding, refresh, atomic
 * persistence, the adapter's access-token resolution, and the status service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  authState, decodeAccessToken, defaultAuthJsonPath, MAX_REFRESH_AGE_MS, mergeRefreshed, needsRefresh,
  readAuthFile, refreshTooOld, refreshTokens, writeAuthFile, CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL,
} from '../src/codex-auth.ts'
import type { CodexAuthFile } from '../src/codex-auth.ts'
import { CodexAuthAdapter, resolveCodexAccessToken } from '../src/codex-auth-adapter.ts'
import { CodexAuthService, type CodexAuthServiceOptions } from '../src/codex-auth-service.ts'
import { Config as PluginConfig, type Config as PluginConfigView } from '../src/index.ts'

/** Captures the options each CodexAuthAdapter hands to the PiAiAdapter base. */
const piAiAdapterCalls: Array<{ profiles: () => ReadonlyMap<string, unknown> }> = []
vi.mock('@deepseek-ai/dsh-llm-pi-ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-llm-pi-ai')>()
  return {
    ...original,
    PiAiAdapter: class {
      constructor(options: { profiles: () => ReadonlyMap<string, unknown> }) {
        piAiAdapterCalls.push(options)
      }
    },
  }
})

/** A fake JWT payload with the locally verifiable claims this plugin reads. */
function fakeJwt(expSeconds: number, accountId = 'acct_test', planType?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    exp: expSeconds,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      ...(planType === undefined ? {} : { chatgpt_plan_type: planType }),
    },
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

describe('decodeAccessToken', () => {
  it('decodes exp and the chatgpt account id from a well-formed JWT', () => {
    const decoded = decodeAccessToken(fakeJwt(1_800_000_000))
    expect(decoded.expSeconds).toBe(1_800_000_000)
    expect(decoded.chatgptAccountId).toBe('acct_test')
  })

  it('answers empty for a non-JWT token', () => {
    expect(decodeAccessToken('not-a-jwt')).toEqual({})
    expect(decodeAccessToken('a.b')).toEqual({})
    expect(decodeAccessToken('')).toEqual({})
  })
})

describe('authState / needsRefresh', () => {
  const nowSeconds = Math.floor(Date.now() / 1000)

  it('extracts the access token and its expiry', () => {
    const state = authState({ tokens: { access_token: fakeJwt(nowSeconds + 3600) } })
    expect(state.accessToken).toBeTruthy()
    expect(state.accessTokenExpiresAt).toBeGreaterThan(Date.now())
  })

  it('answers undefined for an absent or empty token set', () => {
    const state = authState({ auth_mode: 'apikey' })
    expect(state.accessToken).toBeUndefined()
    expect(state.accessTokenExpiresAt).toBeUndefined()
  })

  it('flags an expiring token for refresh within the lead time', () => {
    const expiring = authState({ tokens: { access_token: fakeJwt(nowSeconds + 60) } })
    expect(needsRefresh(expiring, 5 * 60 * 1000)).toBe(true)
    const fresh = authState({ tokens: { access_token: fakeJwt(nowSeconds + 3600) } })
    expect(needsRefresh(fresh, 5 * 60 * 1000)).toBe(false)
  })

  it('flags a refresh older than the codex 8-day interval', () => {
    expect(refreshTooOld({ last_refresh: new Date(Date.now() - MAX_REFRESH_AGE_MS - 60_000).toISOString() }, MAX_REFRESH_AGE_MS)).toBe(true)
    expect(refreshTooOld({ last_refresh: new Date().toISOString() }, MAX_REFRESH_AGE_MS)).toBe(false)
    expect(refreshTooOld({}, MAX_REFRESH_AGE_MS)).toBe(false)
    expect(refreshTooOld(undefined, MAX_REFRESH_AGE_MS)).toBe(false)
  })
})

describe('refreshTokens', () => {
  it('posts the OAuth refresh grant (JSON body, codex client_id) and parses the reply', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe('POST')
      expect(init?.signal).toBe(controller.signal)
      expect((init?.headers as Record<string, string> | undefined)?.['content-type']).toBe('application/json')
      expect(typeof init?.body).toBe('string')
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        client_id?: unknown
        grant_type?: unknown
        refresh_token?: unknown
      }
      expect(body.client_id).toBe(CODEX_OAUTH_CLIENT_ID)
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('rt-1')
      return new Response(JSON.stringify({
        access_token: 'at-2',
        refresh_token: 'rt-2',
        id_token: 'id-2',
        account_id: 'acct-2',
      }), { status: 200 })
    })
    const reply = await refreshTokens('rt-1', fetchMock, controller.signal)
    expect(reply.access_token).toBe('at-2')
    expect(reply.refresh_token).toBe('rt-2')
    expect(reply.account_id).toBe('acct-2')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CODEX_OAUTH_TOKEN_URL)
  })

  it('throws on a non-ok answer', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }))
    await expect(refreshTokens('rt-1', fetchMock)).rejects.toThrow(/401/)
  })

  it('throws when the reply carries no access_token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(refreshTokens('rt-1', fetchMock)).rejects.toThrow(/access_token/)
  })
})

describe('mergeRefreshed', () => {
  it('preserves unknown fields and rotates the token set', () => {
    const before: CodexAuthFile & { agent_identity: string } = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-keep',
      tokens: { access_token: 'at-1', refresh_token: 'rt-1', id_token: 'id-1', account_id: 'acct-1' },
      last_refresh: '2026-01-01T00:00:00.000Z',
      agent_identity: 'keep-me',
    }
    const after = mergeRefreshed(before, { access_token: 'at-2', refresh_token: 'rt-2', account_id: 'acct-2' }) as CodexAuthFile & { agent_identity: string }
    expect(after.auth_mode).toBe('chatgpt')
    expect(after.OPENAI_API_KEY).toBe('sk-keep')
    expect(after.agent_identity).toBe('keep-me')
    expect(after.tokens?.access_token).toBe('at-2')
    expect(after.tokens?.refresh_token).toBe('rt-2')
    expect(after.tokens?.id_token).toBe('id-1')
    expect(after.tokens?.account_id).toBe('acct-2')
    expect(after.last_refresh).toBeTruthy()
  })
})

describe('readAuthFile / writeAuthFile', () => {
  let dir: string

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codex-auth-test-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('answers undefined for an absent file', async () => {
    expect(await readAuthFile(join(dir, 'auth.json'))).toBeUndefined()
  })

  it('round-trips a document atomically and pins owner-only mode', async () => {
    const path = join(dir, 'auth.json')
    const file: CodexAuthFile = { auth_mode: 'chatgpt', tokens: { access_token: 'at' }, last_refresh: 'x' }
    await writeAuthFile(path, file)
    const read = await readAuthFile(path)
    expect(read?.tokens?.access_token).toBe('at')
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('rejects a malformed document instead of reading it as no login', async () => {
    const path = join(dir, 'auth.json')
    await writeFile(path, 'not json', 'utf8')
    await expect(readAuthFile(path)).rejects.toThrow()
  })
})

describe('resolveCodexAccessToken', () => {
  let dir: string
  let authPath: string
  const warn = vi.fn()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-auth-adapter-'))
    authPath = join(dir, 'auth.json')
    warn.mockClear()
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const options = (fetchImpl: typeof fetch): Pick<Parameters<typeof resolveCodexAccessToken>[0], 'authJsonPath' | 'refreshLeadMs' | 'fetchImpl'> => ({
    authJsonPath: authPath,
    refreshLeadMs: 5 * 60 * 1000,
    fetchImpl,
  })

  it('resolves a fresh token from the auth file without refreshing', async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600)
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: token, refresh_token: 'rt-1' } }), 'utf8')
    const fetchMock = vi.fn()
    expect(await resolveCodexAccessToken(options(fetchMock), warn)).toBe(token)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers undefined without a token set or auth file', async () => {
    expect(await resolveCodexAccessToken(options(fetch), warn)).toBeUndefined()
    await writeFile(authPath, JSON.stringify({ auth_mode: 'apikey' }), 'utf8')
    expect(await resolveCodexAccessToken(options(fetch), warn)).toBeUndefined()
  })

  it('refreshes an expiring token through the OAuth endpoint and persists it', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30)
    const refreshed = fakeJwt(Math.floor(Date.now() / 1000) + 3600)
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-keep',
      tokens: { access_token: expiring, refresh_token: 'rt-1', id_token: 'id-1', account_id: 'acct-1' },
      last_refresh: 'old',
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: refreshed, refresh_token: 'rt-2' }), { status: 200 }))
    expect(await resolveCodexAccessToken(options(fetchMock), warn)).toBe(refreshed)
    const persisted = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile
    expect(persisted.tokens?.access_token).toBe(refreshed)
    expect(persisted.tokens?.refresh_token).toBe('rt-2')
    expect(persisted.tokens?.id_token).toBe('id-1')
    expect(persisted.OPENAI_API_KEY).toBe('sk-keep')
    expect(persisted.last_refresh).not.toBe('old')
  })

  it('refreshes a fresh token whose last refresh is older than the 8-day interval', async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600)
    const refreshed = fakeJwt(Math.floor(Date.now() / 1000) + 7200)
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: token, refresh_token: 'rt-1' },
      last_refresh: new Date(Date.now() - MAX_REFRESH_AGE_MS - 60_000).toISOString(),
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: refreshed }), { status: 200 }))
    expect(await resolveCodexAccessToken(options(fetchMock), warn)).toBe(refreshed)
  })

  it('answers undefined and warns when a refresh fails', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30)
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: expiring, refresh_token: 'rt-1' } }), 'utf8')
    const fetchMock = vi.fn(async () => new Response('denied', { status: 403 }))
    expect(await resolveCodexAccessToken(options(fetchMock), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('Auth / LLM row configuration', () => {
  it('keeps the route enabled by default and permits coordinator-only composition', () => {
    const parse = PluginConfig as unknown as (input: Partial<PluginConfigView>) => PluginConfigView
    expect(parse({})).toMatchObject({ llmEnabled: true })
    expect(parse({ llmEnabled: false })).toMatchObject({ llmEnabled: false })
  })

  it('defaults the route to SSE transport with bounded transport timeouts', () => {
    const parse = PluginConfig as unknown as (input: Partial<PluginConfigView>) => PluginConfigView
    expect(parse({})).toMatchObject({
      llmEnabled: true,
      transport: 'sse',
      websocketConnectTimeoutMs: 5_000,
      timeoutMs: 120_000,
    })
    expect(parse({ transport: 'auto', websocketConnectTimeoutMs: 2_000, timeoutMs: 30_000 })).toMatchObject({
      transport: 'auto',
      websocketConnectTimeoutMs: 2_000,
      timeoutMs: 30_000,
    })
  })
})

describe('CodexAuthAdapter route profile', () => {
  it('passes the configured transport and timeouts into the pi-ai profile', () => {
    const ctx = new Context()
    const service = new CodexAuthService(ctx, {
      authJsonPath: '/nonexistent/auth.json',
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
    })
    new CodexAuthAdapter(ctx, {
      auth: service,
      authJsonPath: '/nonexistent/auth.json',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      refreshLeadMs: 5 * 60 * 1000,
      fetchImpl: fetch,
      displayName: 'OpenAI Codex (chatgpt)',
      transport: 'auto',
      websocketConnectTimeoutMs: 3_000,
      timeoutMs: 60_000,
    })
    const options = piAiAdapterCalls.at(-1)
    const profile = options?.profiles().get('openai-codex') as Record<string, unknown> | undefined
    expect(profile).toMatchObject({ transport: 'auto', websocketConnectTimeoutMs: 3_000, timeoutMs: 60_000 })
  })
})

describe('CodexAuthService authenticated operation boundary', () => {
  let dir: string
  let authPath: string
  let ctx: Context

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-auth-coordinator-'))
    authPath = join(dir, 'auth.json')
    ctx = new Context()
  })
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  function service(
    fetchImpl: typeof fetch,
    refreshLeadMs = 5 * 60 * 1000,
    disposeTimeoutMs?: number,
    authFileWriter?: (path: string, file: CodexAuthFile) => Promise<void>,
  ): CodexAuthService {
    return new CodexAuthService(ctx, {
      authJsonPath: authPath,
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      refreshLeadMs,
      fetchImpl,
      ...(disposeTimeoutMs === undefined ? {} : { disposeTimeoutMs }),
      ...(authFileWriter === undefined ? {} : { authFileWriter }),
    })
  }

  async function advanceBackgroundClock(coordinator: CodexAuthService, milliseconds: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds)
    const flight: unknown = Reflect.get(coordinator, 'backgroundRefreshFlight')
    if (flight instanceof Promise) await flight
  }

  it('coalesces concurrent refreshes and returns account-scoped credentials', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-1')
    const refreshed = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1', 'plus')
    await writeFile(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: expiring, refresh_token: 'refresh-secret', account_id: 'acct-1' },
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: refreshed,
      refresh_token: 'rotated-secret',
      account_id: 'acct-1',
    }), { status: 200 }))
    const coordinator = service(fetchMock)

    const credentials = await Promise.all(Array.from({ length: 8 }, () => coordinator.credential()))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(credentials).toEqual(Array.from({ length: 8 }, () => ({
      accessToken: refreshed,
      accountId: 'acct-1',
      planType: 'plus',
    })))
  })

  it('treats a missing pre-lock read only as a hint and adopts the locked document', async () => {
    const fresh = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    const fetchMock = vi.fn()
    const coordinator = service(fetchMock)
    let pending: Promise<Awaited<ReturnType<CodexAuthService['credential']>>> | undefined

    await withFileLock(authPath, async () => {
      pending = coordinator.credential()
      await new Promise(resolve => setTimeout(resolve, 20))
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: fresh, refresh_token: 'other-secret', account_id: 'acct-1' },
      }), 'utf8')
    })

    await expect(pending).resolves.toMatchObject({ accessToken: fresh, accountId: 'acct-1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-reads under the cross-process lock before deciding to refresh', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-1')
    const fresh = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: expiring, refresh_token: 'refresh-secret', account_id: 'acct-1' },
    }), 'utf8')
    const fetchMock = vi.fn()
    const coordinator = service(fetchMock)
    let pending: Promise<Awaited<ReturnType<CodexAuthService['credential']>>> | undefined

    await withFileLock(authPath, async () => {
      pending = coordinator.credential()
      await new Promise(resolve => setTimeout(resolve, 20))
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: fresh, refresh_token: 'other-secret', account_id: 'acct-1' },
      }), 'utf8')
    })

    await expect(pending).resolves.toMatchObject({ accessToken: fresh, accountId: 'acct-1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adopts a newer matching-account login after refresh-token reuse', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-1')
    const replacement = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: expiring, refresh_token: 'consumed-secret', account_id: 'acct-1' },
      last_refresh: '2026-01-01T00:00:00.000Z',
    }), 'utf8')
    const fetchMock = vi.fn(async () => {
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: replacement, refresh_token: 'cli-secret', account_id: 'acct-1' },
        // A fresh CLI login: recent last_refresh keeps the background refresher
        // from re-arming at zero delay while this test's temp dir is removed.
        last_refresh: new Date().toISOString(),
      }), 'utf8')
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    })

    await expect(service(fetchMock).credential()).resolves.toMatchObject({
      accessToken: replacement,
      accountId: 'acct-1',
    })
  })

  it('refuses to adopt a replacement login for a different account', async () => {
    const expiring = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-1')
    const replacement = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-2')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: expiring, refresh_token: 'consumed-secret', account_id: 'acct-1' },
    }), 'utf8')
    const fetchMock = vi.fn(async () => {
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: replacement, refresh_token: 'other-secret', account_id: 'acct-2' },
      }), 'utf8')
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    })

    await expect(service(fetchMock).credential()).resolves.toBeUndefined()
  })

  it('does not merge a successful stale refresh into a changed account that is still due', async () => {
    const expiringA = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-1')
    const expiringB = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-2')
    const refreshedA = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: expiringA, refresh_token: 'rt-a', account_id: 'acct-1' },
    }), 'utf8')
    const replacement = {
      tokens: { access_token: expiringB, refresh_token: 'rt-b', account_id: 'acct-2' },
    }
    const fetchMock = vi.fn(async () => {
      await writeFile(authPath, JSON.stringify(replacement), 'utf8')
      return new Response(JSON.stringify({
        access_token: refreshedA,
        refresh_token: 'rt-a-rotated',
        account_id: 'acct-1',
      }), { status: 200 })
    })

    await expect(service(fetchMock).credential()).resolves.toBeUndefined()
    await expect(readAuthFile(authPath)).resolves.toEqual(replacement)
  })

  it('fails closed when an initially unknown account conflicts with the current file and refresh reply', async () => {
    const expiringB = fakeJwt(Math.floor(Date.now() / 1000) + 30, 'acct-2')
    const refreshedA = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    await writeFile(authPath, JSON.stringify({
      last_refresh: '2000-01-01T00:00:00.000Z',
      tokens: { access_token: 'opaque-token', refresh_token: 'shared-refresh-token' },
    }), 'utf8')
    const replacement = {
      tokens: { access_token: expiringB, refresh_token: 'shared-refresh-token', account_id: 'acct-2' },
    }
    const fetchMock = vi.fn(async () => {
      await writeFile(authPath, JSON.stringify(replacement), 'utf8')
      return new Response(JSON.stringify({
        access_token: refreshedA,
        refresh_token: 'rt-a-rotated',
        account_id: 'acct-1',
      }), { status: 200 })
    })

    await expect(service(fetchMock).credential()).resolves.toBeUndefined()
    await expect(readAuthFile(authPath)).resolves.toEqual(replacement)
  })

  it('re-reads the auth file when it changes externally and serves the rotated login without refreshing', async () => {
    const tokenA = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    const tokenB = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: tokenA, refresh_token: 'rt-1', account_id: 'acct-1' },
    }), 'utf8')
    const fetchMock = vi.fn()
    const coordinator = service(fetchMock)

    await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: tokenA })
    // The Codex CLI rotates the login in the file (e.g. a fresh `codex login`).
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: tokenB, refresh_token: 'rt-2', account_id: 'acct-1' },
    }), 'utf8')

    await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: tokenB })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('invalidates a cached credential when content changes without changing mtime', async () => {
    const tokenA = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-1')
    const tokenB = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct-2')
    const fixedTime = new Date('2026-08-14T12:00:00.000Z')
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: tokenA, refresh_token: 'rt-1', account_id: 'acct-1' },
    }), 'utf8')
    await utimes(authPath, fixedTime, fixedTime)
    const coordinator = service(vi.fn())

    await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: tokenA, accountId: 'acct-1' })
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: tokenB, refresh_token: 'rt-2', account_id: 'acct-2' },
    }), 'utf8')
    await utimes(authPath, fixedTime, fixedTime)

    await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: tokenB, accountId: 'acct-2' })
  })

  it('refuses a cached credential that has neared expiry and refreshes once', async () => {
    const realNow = Date.now()
    let now = realNow
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const nowSeconds = Math.floor(now / 1000)
      const token = fakeJwt(nowSeconds + 6, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: token, refresh_token: 'rt-1', account_id: 'acct-1' },
      }), 'utf8')
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        access_token: refreshed,
        refresh_token: 'rt-2',
        account_id: 'acct-1',
      }), { status: 200 }))
      const coordinator = service(fetchMock, 1_000)

      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: token })
      expect(fetchMock).not.toHaveBeenCalled()

      // Cross the 1s lead without a wall-clock sleep: the cached entry must be
      // refused and refreshed exactly once.
      now = realNow + 5200
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: refreshed })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('pre-refreshes in the background before the access token nears expiry', async () => {
    // Fake only the clock APIs this flow uses; setImmediate stays real so each
    // advance step can let the file-system work of the refresh chain settle.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      // 420s of remaining validity: outside the 300s lead at resolve time, so
      // the first credential is served without a refresh, while the background
      // timer (armed at exp - lead - grace = 60s) crosses the lead on its
      // second firing.
      const token = fakeJwt(nowSeconds + 420, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: token, refresh_token: 'rt-1', account_id: 'acct-1' },
      }), 'utf8')
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        access_token: refreshed,
        refresh_token: 'rt-2',
        account_id: 'acct-1',
      }), { status: 200 }))
      const coordinator = service(fetchMock)

      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: token })
      expect(fetchMock).not.toHaveBeenCalled()

      // Walk the clock in one-minute steps past the armed timer and its +60s
      // re-arms; the first firing is a no-op, the second is a no-op at the
      // exact lead boundary, and the third crosses the lead and refreshes.
      for (let step = 0; step < 6 && fetchMock.mock.calls.length === 0; step++) {
        await advanceBackgroundClock(coordinator, 60 * 1000)
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // The background refresh rewrites the auth file with the rotated token
      // set. Poll the file (with real I/O settling between reads) instead of
      // calling credential() again, which would race the refresh chain for
      // the writer lock under the faked backoff timers. The "serve the rotated
      // login without refreshing" half is covered by the version-bust test.
      let persisted: CodexAuthFile | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        persisted = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile
        if (persisted.tokens?.access_token === refreshed) break
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(persisted?.tokens?.access_token).toBe(refreshed)
      expect(persisted?.tokens?.refresh_token).toBe('rt-2')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('reschedules background refresh when an external login expires sooner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const later = fakeJwt(nowSeconds + 3600, 'acct-1')
      const sooner = fakeJwt(nowSeconds + 420, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: later, refresh_token: 'rt-later', account_id: 'acct-1' },
      }), 'utf8')
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        access_token: refreshed,
        refresh_token: 'rt-refreshed',
        account_id: 'acct-1',
      }), { status: 200 }))
      const coordinator = service(fetchMock)
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: later })

      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: sooner, refresh_token: 'rt-sooner', account_id: 'acct-1' },
      }), 'utf8')
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: sooner })

      for (let step = 0; step < 6 && fetchMock.mock.calls.length === 0; step++) {
        await advanceBackgroundClock(coordinator, 60 * 1000)
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('waits for an in-flight proactive refresh during disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const current = fakeJwt(nowSeconds + 420, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: current, refresh_token: 'rt-current', account_id: 'acct-1' },
      }), 'utf8')
      let markStarted!: () => void
      let releaseRefresh!: () => void
      let refreshSignal: AbortSignal | null | undefined
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const released = new Promise<void>(resolve => { releaseRefresh = resolve })
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        refreshSignal = init?.signal
        markStarted()
        await released
        return new Response(JSON.stringify({
          access_token: refreshed,
          refresh_token: 'rt-refreshed',
          account_id: 'acct-1',
        }), { status: 200 })
      })
      const coordinator = service(fetchMock)
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: current })

      for (let step = 0; step < 6 && fetchMock.mock.calls.length === 0; step++) {
        vi.advanceTimersByTime(60 * 1000)
        for (let settle = 0; settle < 20 && fetchMock.mock.calls.length === 0; settle++) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }
      await started

      let disposed = false
      const disposal = ctx.fiber.dispose().then(() => { disposed = true })
      for (let settle = 0; settle < 10 && !disposed; settle++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const disposedBeforeRelease = disposed
      const abortedBeforeRelease = refreshSignal?.aborted

      releaseRefresh()
      await disposal
      expect(disposedBeforeRelease).toBe(false)
      expect(abortedBeforeRelease).toBe(true)
      expect(disposed).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('bounds disposal when an injected proactive refresh ignores abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const current = fakeJwt(nowSeconds + 420, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: current, refresh_token: 'rt-current', account_id: 'acct-1' },
      }), 'utf8')
      let markStarted!: () => void
      let releaseRefresh!: () => void
      let refreshSignal: AbortSignal | null | undefined
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const released = new Promise<void>(resolve => { releaseRefresh = resolve })
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        refreshSignal = init?.signal
        markStarted()
        await released
        return new Response(JSON.stringify({
          access_token: refreshed,
          refresh_token: 'rt-refreshed',
          account_id: 'acct-1',
        }), { status: 200 })
      })
      const coordinator = service(fetchMock, 5 * 60 * 1000, 25)
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: current })

      for (let step = 0; step < 6 && fetchMock.mock.calls.length === 0; step++) {
        vi.advanceTimersByTime(60 * 1000)
        for (let settle = 0; settle < 20 && fetchMock.mock.calls.length === 0; settle++) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }
      await started
      const backgroundFlight: unknown = Reflect.get(coordinator, 'backgroundRefreshFlight')

      let disposed = false
      const disposal = ctx.fiber.dispose().then(() => { disposed = true })
      for (let settle = 0; settle < 10; settle++) await new Promise(resolve => setImmediate(resolve))
      const abortedDuringDisposal = refreshSignal?.aborted
      vi.advanceTimersByTime(25)
      for (let settle = 0; settle < 10 && !disposed; settle++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const disposedAfterDeadline = disposed

      releaseRefresh()
      await disposal
      if (backgroundFlight instanceof Promise) await backgroundFlight
      expect(abortedDuringDisposal).toBe(true)
      expect(disposedAfterDeadline).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await expect(readAuthFile(authPath)).resolves.toMatchObject({
        tokens: { access_token: current, refresh_token: 'rt-current', account_id: 'acct-1' },
      })
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps overlapping service flights lifecycle-neutral and detaches a disposed caller', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const current = fakeJwt(nowSeconds + 30, 'acct-1')
      const staleReply = fakeJwt(nowSeconds + 3600, 'acct-1')
      const replacementReply = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: current, refresh_token: 'rt-current', account_id: 'acct-1' },
      }), 'utf8')

      let markStaleStarted!: () => void
      let releaseStale!: () => void
      let staleSignal: AbortSignal | null | undefined
      const staleStarted = new Promise<void>(resolve => { markStaleStarted = resolve })
      const staleReleased = new Promise<void>(resolve => { releaseStale = resolve })
      const staleFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        staleSignal = init?.signal
        markStaleStarted()
        await staleReleased
        return new Response(JSON.stringify({
          access_token: staleReply,
          refresh_token: 'rt-stale',
          account_id: 'acct-1',
        }), { status: 200 })
      })
      const staleContext = ctx
      const staleCoordinator = service(staleFetch, 5 * 60 * 1000, 25)
      const statusChanged = vi.fn()
      staleCoordinator.watchStatus(statusChanged)
      let staleSettled = false
      let staleResult: Awaited<ReturnType<CodexAuthService['credential']>>
      const staleCredential = staleCoordinator.credential().then(result => {
        staleSettled = true
        staleResult = result
        return result
      })
      await staleStarted
      statusChanged.mockClear()
      const staleFlight: unknown = Reflect.get(staleCoordinator, 'credentialFlight')

      let markReplacementStarted!: () => void
      let releaseReplacement!: () => void
      let replacementSignal: AbortSignal | null | undefined
      const replacementStarted = new Promise<void>(resolve => { markReplacementStarted = resolve })
      const replacementReleased = new Promise<void>(resolve => { releaseReplacement = resolve })
      ctx = new Context()
      const replacementFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        replacementSignal = init?.signal
        markReplacementStarted()
        await replacementReleased
        return new Response(JSON.stringify({
          access_token: replacementReply,
          refresh_token: 'rt-replacement',
          account_id: 'acct-1',
        }), { status: 200 })
      })
      const replacementCoordinator = service(replacementFetch, 5 * 60 * 1000, 25)
      const replacementCredential = replacementCoordinator.credential()
      const replacementFlight: unknown = Reflect.get(replacementCoordinator, 'credentialFlight')
      const independentFlights = staleFlight instanceof Promise
        && replacementFlight instanceof Promise
        && staleFlight !== replacementFlight
      if (independentFlights) await replacementStarted

      let disposed = false
      const disposal = staleContext.fiber.dispose().then(() => { disposed = true })
      for (let settle = 0; settle < 10; settle++) await new Promise(resolve => setImmediate(resolve))
      const staleAbortedDuringDisposal = staleSignal?.aborted
      const callerDetachedBeforeRelease = staleSettled && staleResult === undefined
      const replacementStayedActive = replacementSignal?.aborted === false
      vi.advanceTimersByTime(25)
      for (let settle = 0; settle < 10 && !disposed; settle++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const disposedAfterDeadline = disposed

      releaseReplacement()
      const replacementResult = await replacementCredential
      releaseStale()
      await staleCredential
      if (staleFlight instanceof Promise) await staleFlight
      await disposal

      expect(independentFlights).toBe(true)
      expect(staleAbortedDuringDisposal).toBe(true)
      expect(callerDetachedBeforeRelease).toBe(true)
      expect(replacementStayedActive).toBe(true)
      expect(disposedAfterDeadline).toBe(true)
      expect(statusChanged).not.toHaveBeenCalled()
      expect(replacementResult).toMatchObject({ accessToken: replacementReply, accountId: 'acct-1' })
      await expect(readAuthFile(authPath)).resolves.toMatchObject({
        tokens: { access_token: replacementReply, refresh_token: 'rt-replacement', account_id: 'acct-1' },
      })
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps disposal joined to an atomic auth-file commit already in progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const current = fakeJwt(nowSeconds + 30, 'acct-1')
      const refreshed = fakeJwt(nowSeconds + 3600, 'acct-1')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: current, refresh_token: 'rt-current', account_id: 'acct-1' },
      }), 'utf8')
      let markCommitStarted!: () => void
      let releaseCommit!: () => void
      const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve })
      const commitReleased = new Promise<void>(resolve => { releaseCommit = resolve })
      const writer = vi.fn(async (path: string, file: CodexAuthFile) => {
        markCommitStarted()
        await commitReleased
        await writeAuthFile(path, file)
      })
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        access_token: refreshed,
        refresh_token: 'rt-refreshed',
        account_id: 'acct-1',
      }), { status: 200 }))
      const coordinator = service(fetchMock, 5 * 60 * 1000, 25, writer)
      const credential = coordinator.credential()
      await commitStarted

      let disposed = false
      const disposal = ctx.fiber.dispose().then(() => { disposed = true })
      for (let settle = 0; settle < 10; settle++) await new Promise(resolve => setImmediate(resolve))
      vi.advanceTimersByTime(25)
      for (let settle = 0; settle < 10 && !disposed; settle++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const disposedWhileCommitPending = disposed

      releaseCommit()
      const result = await credential
      await disposal
      expect(disposedWhileCommitPending).toBe(false)
      expect(disposed).toBe(true)
      expect(result).toBeUndefined()
      expect(writer).toHaveBeenCalledTimes(1)
      await expect(readAuthFile(authPath)).resolves.toMatchObject({
        tokens: { access_token: refreshed, refresh_token: 'rt-refreshed', account_id: 'acct-1' },
      })
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('retries proactive refresh after rejecting a stale success for a changed due login', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const tokenA = fakeJwt(nowSeconds + 420, 'acct-1')
      const tokenB = fakeJwt(nowSeconds + 420, 'acct-2')
      const refreshedA = fakeJwt(nowSeconds + 3600, 'acct-1')
      const refreshedB = fakeJwt(nowSeconds + 3600, 'acct-2')
      await writeFile(authPath, JSON.stringify({
        tokens: { access_token: tokenA, refresh_token: 'rt-a', account_id: 'acct-1' },
      }), 'utf8')
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const refreshToken = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token
        if (refreshToken === 'rt-a') {
          await writeFile(authPath, JSON.stringify({
            tokens: { access_token: tokenB, refresh_token: 'rt-b', account_id: 'acct-2' },
          }), 'utf8')
          return new Response(JSON.stringify({
            access_token: refreshedA,
            refresh_token: 'rt-a-rotated',
            account_id: 'acct-1',
          }), { status: 200 })
        }
        return new Response(JSON.stringify({
          access_token: refreshedB,
          refresh_token: 'rt-b-rotated',
          account_id: 'acct-2',
        }), { status: 200 })
      })
      const coordinator = service(fetchMock)
      await expect(coordinator.credential()).resolves.toMatchObject({ accessToken: tokenA })

      for (let step = 0; step < 6 && fetchMock.mock.calls.length === 0; step++) {
        await advanceBackgroundClock(coordinator, 60 * 1000)
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      for (let step = 0; step < 12 && fetchMock.mock.calls.length < 2; step++) {
        await advanceBackgroundClock(coordinator, 60 * 1000)
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })
})

describe('CodexAuthService', () => {
  let dir: string
  let ctx: Context

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codex-auth-service-')); ctx = new Context() })
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('reports availability, account, plan, and timestamps without token material', async () => {
    const authPath = join(dir, 'auth.json')
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600, 'acct_test', 'plus')
    await mkdir(dir, { recursive: true })
    await writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token }, last_refresh: '2026-08-10T00:00:00.000Z' }), 'utf8')
    const service = new CodexAuthService(ctx, { authJsonPath: authPath, codexCommand: 'definitely-not-codex', credentialRef: credentialRef('CODEX_CHATGPT_TOKEN') })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.configured).toBe(true)
    expect(status.authFileExists).toBe(true)
    expect(status.authMode).toBe('chatgpt')
    expect(status.lastRefreshAt).toBe('2026-08-10T00:00:00.000Z')
    expect(status.tokenExpiresAt).toBeTruthy()
    expect(status.accountId).toBe('acct_test')
    expect(status.planType).toBe('plus')
    expect(status.credentialRef).toBe('CODEX_CHATGPT_TOKEN')
    expect(JSON.stringify(status)).not.toContain(token)
  })

  it('force-stops and detaches a codex CLI probe that ignores SIGTERM', async () => {
    type Spawn = NonNullable<CodexAuthServiceOptions['spawnImpl']>
    const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const unref = vi.fn()
    let child!: ReturnType<Spawn>
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') queueMicrotask(() => { child.emit('close', null, 'SIGKILL') })
      return true
    })
    child = Object.assign(new EventEmitter(), { stdout, stderr, kill, unref }) as unknown as ReturnType<Spawn>
    const spawnImpl = vi.fn(() => child) as unknown as Spawn
    const coordinator = new CodexAuthService(ctx, {
      authJsonPath: join(dir, 'auth.json'),
      codexCommand: 'slow-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      spawnImpl,
      probeStopTimeoutMs: 1,
    })
    child.emit('spawn')
    stdout.emit('data', Buffer.from('codex-cli 9.9.9\n'))

    await ctx.fiber.dispose()
    expect(spawnImpl).toHaveBeenCalledWith('slow-codex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stdout.destroy).toHaveBeenCalledTimes(1)
    expect(stderr.destroy).toHaveBeenCalledTimes(1)
    expect(unref).toHaveBeenCalledTimes(1)
    expect(coordinator.available).toBe(false)
  })

  it('refuses login when the codex CLI is unavailable', async () => {
    const service = new CodexAuthService(ctx, { authJsonPath: join(dir, 'auth.json'), codexCommand: 'definitely-not-codex', credentialRef: credentialRef('CODEX_CHATGPT_TOKEN') })
    await expect(service.login('browser')).rejects.toThrow(/not on PATH/)
  })

  it('resolves the auth file path from CODEX_HOME, then ~/.codex', () => {
    expect(defaultAuthJsonPath({ CODEX_HOME: '/x' })).toBe('/x/auth.json')
    expect(defaultAuthJsonPath({})).toBe(join(process.env.HOME ?? '', '.codex', 'auth.json'))
  })
})
