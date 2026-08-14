/**
 * Host-side tests for the codex-auth plugin: token decoding, refresh, atomic
 * persistence, the adapter's access-token resolution, and the status service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { resolveCodexAccessToken } from '../src/codex-auth-adapter.ts'
import { CodexAuthService } from '../src/codex-auth-service.ts'
import { Config as PluginConfig, type Config as PluginConfigView } from '../src/index.ts'

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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe('POST')
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
    const reply = await refreshTokens('rt-1', fetchMock)
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
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  function service(fetchImpl: typeof fetch): CodexAuthService {
    return new CodexAuthService(ctx, {
      authJsonPath: authPath,
      codexCommand: 'definitely-not-codex',
      credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
      refreshLeadMs: 5 * 60 * 1000,
      fetchImpl,
    })
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
        last_refresh: '2026-02-01T00:00:00.000Z',
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
})

describe('CodexAuthService', () => {
  let dir: string
  let ctx: Context

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codex-auth-service-')); ctx = new Context() })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

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

  it('refuses login when the codex CLI is unavailable', async () => {
    const service = new CodexAuthService(ctx, { authJsonPath: join(dir, 'auth.json'), codexCommand: 'definitely-not-codex', credentialRef: credentialRef('CODEX_CHATGPT_TOKEN') })
    await expect(service.login('browser')).rejects.toThrow(/not on PATH/)
  })

  it('resolves the auth file path from CODEX_HOME, then ~/.codex', () => {
    expect(defaultAuthJsonPath({ CODEX_HOME: '/x' })).toBe('/x/auth.json')
    expect(defaultAuthJsonPath({})).toBe(join(process.env.HOME ?? '', '.codex', 'auth.json'))
  })
})
