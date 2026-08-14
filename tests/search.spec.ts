/** Public WebRuntime seam regressions for the Global Codex Search Provider. */
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_SEARCH_ENDPOINT, CODEX_SEARCH_PROVIDER_ID, CodexSearchProvider,
  type CodexSearchSettings,
} from '../src/search.ts'

const SETTINGS: CodexSearchSettings = {
  enabled: true,
  mode: 'live',
  contextSize: 'medium',
  fallbackModel: 'gpt-5.4',
  maxOutputTokens: 2048,
}

function auth() {
  return {
    credential: vi.fn(() => Promise.resolve({
      accessToken: 'access-secret',
      accountId: 'acct-1',
      planType: 'plus',
    })),
  }
}

function provider(
  fetchImpl: typeof fetch,
  settings: () => CodexSearchSettings = () => SETTINGS,
): CodexSearchProvider {
  return new CodexSearchProvider({
    auth: auth(),
    settings,
    fetchImpl,
    requestId: () => 'search-request-1',
    retryBaseDelayMs: 0,
  })
}

describe('Global Codex Search Provider', () => {
  it('dispatches the official standalone-search contract through WebRuntime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(CODEX_SEARCH_ENDPOINT)
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer access-secret')
      expect(headers.get('chatgpt-account-id')).toBe('acct-1')
      expect(headers.get('originator')).toBe('dsh-codex-auth')
      expect(JSON.parse(String(init?.body))).toEqual({
        id: 'search-request-1',
        model: 'gpt-5.4',
        input: 'DeepSeek Harness plugins',
        commands: {
          search_query: [{ q: 'DeepSeek Harness plugins' }],
        },
        settings: {
          search_context_size: 'medium',
          allowed_callers: ['direct'],
          external_web_access: 'live',
        },
        max_output_tokens: 2048,
      })
      return new Response(JSON.stringify({
        encrypted_output: null,
        output: 'Evidence summary',
        results: [
          { url: 'https://example.com/a', title: 'Result A', snippet: 'Trusted snippet' },
          { url: 'https://example.com/a', title: 'Duplicate' },
          { source_url: 'https://example.com/b', source_title: 'Result B', text: 'Source text' },
          { url: 'ftp://example.com/file', title: 'Not HTTP' },
          { arbitrary: { url: 'https://example.com/nested' } },
        ],
      }), { status: 200 })
    })
    const ctx = new Context()
    const web = new WebRuntime(ctx)
    web.registerSearchProvider(provider(fetchMock))

    const result = await web.search({ query: 'DeepSeek Harness plugins', maxResults: 1 })

    expect(result).toEqual({
      content: 'Evidence summary',
      sources: [{ url: 'https://example.com/a', title: 'Result A', snippet: 'Trusted snippet' }],
      truncated: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(web.search).toBeTypeOf('function')
  })

  it('applies enabled state live without a registration gap', async () => {
    let current = SETTINGS
    const ctx = new Context()
    const web = new WebRuntime(ctx)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output: 'ok', results: [] })))
    web.registerSearchProvider(provider(fetchMock, () => current))

    await expect(web.search({ query: 'first' })).resolves.toMatchObject({ content: 'ok' })
    current = { ...SETTINGS, enabled: false }
    await expect(web.search({ query: 'disabled' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    current = { ...SETTINGS, enabled: true, mode: 'cached' }
    await expect(web.search({ query: 'enabled again' })).resolves.toMatchObject({ content: 'ok' })
  })

  it('retries network and 5xx failures at most five attempts, but never retries 429', async () => {
    const transient = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: 'recovered', results: [] }), { status: 200 }))
    await expect(provider(transient).search({ query: 'retry' })).resolves.toMatchObject({ content: 'recovered' })
    expect(transient).toHaveBeenCalledTimes(3)

    const exhausted = vi.fn(async () => new Response('temporary', { status: 500 }))
    await expect(provider(exhausted).search({ query: 'fail' })).rejects.toMatchObject({ code: 'CODEX_SEARCH_UPSTREAM' })
    expect(exhausted).toHaveBeenCalledTimes(5)

    const limited = vi.fn(async () => new Response('slow down', { status: 429 }))
    await expect(provider(limited).search({ query: 'quota' })).rejects.toMatchObject({ code: 'CODEX_SEARCH_RATE_LIMIT' })
    expect(limited).toHaveBeenCalledTimes(1)
  })

  it('uses the initiating Codex model when known and the configured fallback otherwise', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ output: 'ok', results: [] }))
    })
    const currentModel = new CodexSearchProvider({
      auth: auth(),
      settings: () => ({ ...SETTINGS, fallbackModel: 'fallback-model', mode: 'indexed' }),
      initiatingModel: () => 'current-codex-model',
      fetchImpl: fetchMock,
      requestId: () => 'current',
      retryBaseDelayMs: 0,
    })
    const fallback = new CodexSearchProvider({
      auth: auth(),
      settings: () => ({ ...SETTINGS, fallbackModel: 'fallback-model' }),
      initiatingModel: () => undefined,
      fetchImpl: fetchMock,
      requestId: () => 'fallback',
      retryBaseDelayMs: 0,
    })

    await currentModel.search({ query: 'current' })
    await fallback.search({ query: 'fallback' })

    expect(bodies[0]).toMatchObject({
      model: 'current-codex-model',
      settings: { external_web_access: 'indexed' },
    })
    expect(bodies[1]).toMatchObject({ model: 'fallback-model' })
  })

  it('aborts pending retry backoff promptly', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response('temporary', { status: 503 }))
    const search = new CodexSearchProvider({
      auth: auth(),
      settings: () => SETTINGS,
      fetchImpl: fetchMock,
      requestId: () => 'cancelled',
      retryBaseDelayMs: 60_000,
    })

    const pending = search.search({ query: 'cancel during backoff' }, controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'CODEX_SEARCH_CANCELLED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const activeController = new AbortController()
    const activeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener('abort', () => {
          stream.error(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      },
    })))
    const active = new CodexSearchProvider({
      auth: auth(),
      settings: () => SETTINGS,
      fetchImpl: activeFetch,
      requestId: () => 'active-cancelled',
      retryBaseDelayMs: 0,
    })
    const activePending = active.search({ query: 'cancel active body' }, activeController.signal)
    await vi.waitFor(() => expect(activeFetch).toHaveBeenCalledTimes(1))
    activeController.abort()
    await expect(activePending).rejects.toMatchObject({ code: 'CODEX_SEARCH_CANCELLED' })
  })

  it('fails with codex-login guidance before dispatch when auth is unavailable', async () => {
    const fetchMock = vi.fn()
    const search = new CodexSearchProvider({
      auth: { credential: () => Promise.resolve(undefined) },
      settings: () => SETTINGS,
      fetchImpl: fetchMock,
      requestId: () => 'search-request-1',
      retryBaseDelayMs: 0,
    })

    expect(search.id).toBe(CODEX_SEARCH_PROVIDER_ID)
    await expect(search.search({ query: 'anything' })).rejects.toMatchObject({
      code: 'CODEX_AUTH_REQUIRED',
      message: expect.stringContaining('codex login'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
