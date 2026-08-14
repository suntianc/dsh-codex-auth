/** Codex standalone-search provider and independently live Search row. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { CodexAuthService } from './codex-auth-service.ts'
import { CODEX_ROUTE } from './codex-auth-adapter.ts'
import { readBoundedResponseText } from './bounded-response.ts'

/** Stable provider id selected by DSH's stock `web_search` Capability Tool. */
export const CODEX_SEARCH_PROVIDER_ID = 'codex'
/** Official standalone search endpoint used by Codex 0.147.0. */
export const CODEX_SEARCH_ENDPOINT = 'https://chatgpt.com/backend-api/codex/alpha/search'
export const CODEX_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('codex-search')

const MAX_SEARCH_ATTEMPTS = 5
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_RETRY_BASE_DELAY_MS = 100

export type CodexSearchMode = 'live' | 'cached' | 'indexed'
export type CodexSearchContextSize = 'low' | 'medium' | 'high'

/** Independently live settings for the Global Codex Search Provider. */
export interface CodexSearchSettings {
  enabled: boolean
  mode: CodexSearchMode
  contextSize: CodexSearchContextSize
  fallbackModel: string
  maxOutputTokens: number
}

export interface Config extends CodexSearchSettings {}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  mode: z.union([z.const('live'), z.const('cached'), z.const('indexed')]).default('live'),
  contextSize: z.union([z.const('low'), z.const('medium'), z.const('high')]).default('medium'),
  fallbackModel: z.string().default('gpt-5.4'),
  maxOutputTokens: z.number().step(1).min(1).default(2048),
})

export interface CodexSearchProviderOptions {
  auth: Pick<CodexAuthService, 'credential'>
  settings: () => CodexSearchSettings
  fetchImpl: typeof fetch
  /** Stable request/session id for the current operation. */
  requestId?: () => string
  /** Current initiating Codex model, or undefined to use the fallback setting. */
  initiatingModel?: () => string | undefined
  /** Injectable only to make the public retry behavior deterministic in fixtures. */
  retryBaseDelayMs?: number
}

/** Codex backend implementation behind DSH's existing stock `web_search` tool. */
export class CodexSearchProvider implements WebSearchProvider {
  readonly id = CODEX_SEARCH_PROVIDER_ID

  constructor(private readonly options: CodexSearchProviderOptions) {}

  available(): boolean {
    return this.options.settings().enabled
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal, 'CODEX_SEARCH_CANCELLED')
    const settings = this.options.settings()
    if (!settings.enabled) {
      throw new WebError('Codex Web Search is disabled in GPT Auth settings', 'CODEX_SEARCH_DISABLED')
    }
    const credential = await this.options.auth.credential(signal)
    if (credential === undefined) {
      throw new WebError(
        'Codex Web Search requires a usable Codex Login State; run `codex login` and try again',
        'CODEX_AUTH_REQUIRED',
      )
    }

    const body = {
      id: this.options.requestId?.() ?? randomUUID(),
      model: this.options.initiatingModel?.() ?? settings.fallbackModel,
      input: request.query,
      commands: { search_query: [{ q: request.query }] },
      settings: {
        search_context_size: settings.contextSize,
        allowed_callers: ['direct'],
        external_web_access: settings.mode,
      },
      max_output_tokens: settings.maxOutputTokens,
    }
    const response = await this.dispatch(body, credential, signal)
    return normalizeSearchResponse(response)
  }

  private async dispatch(
    body: object,
    credential: { accessToken: string; accountId?: string },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const retryBaseDelayMs = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal, 'CODEX_SEARCH_CANCELLED')
      let response: Response
      try {
        response = await this.options.fetchImpl(CODEX_SEARCH_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            ...(credential.accountId === undefined ? {} : { 'chatgpt-account-id': credential.accountId }),
            'content-type': 'application/json',
            originator: 'dsh-codex-auth',
            'user-agent': 'dsh-codex-auth/0.1.0',
          },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        if (signal?.aborted === true) throw cancelledError('CODEX_SEARCH_CANCELLED', signal)
        if (attempt < MAX_SEARCH_ATTEMPTS) {
          await abortableDelay(retryBaseDelayMs * 2 ** (attempt - 1), signal, 'CODEX_SEARCH_CANCELLED')
          continue
        }
        throw new WebError('Codex Web Search failed after five transport attempts', 'CODEX_SEARCH_NETWORK')
      }

      if (response.status === 429) {
        throw new WebError('Codex Web Search was rate-limited; retry later', 'CODEX_SEARCH_RATE_LIMIT')
      }
      if (response.status >= 500 && response.status <= 599 && attempt < MAX_SEARCH_ATTEMPTS) {
        await cancelBody(response)
        await abortableDelay(retryBaseDelayMs * 2 ** (attempt - 1), signal, 'CODEX_SEARCH_CANCELLED')
        continue
      }
      if (!response.ok) {
        await cancelBody(response)
        throw new WebError(
          `Codex Web Search returned HTTP ${response.status}`,
          'CODEX_SEARCH_UPSTREAM',
        )
      }

      const text = await readBoundedResponseText(response, MAX_SEARCH_RESPONSE_BYTES, signal, {
        tooLarge: () => new WebError('Codex Web Search response exceeded the safe size limit', 'CODEX_SEARCH_RESPONSE_TOO_LARGE'),
        cancelled: () => new WebError('Codex Web Search was cancelled', 'CODEX_SEARCH_CANCELLED'),
      })
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new WebError('Codex Web Search returned an invalid JSON envelope', 'CODEX_SEARCH_RESPONSE')
      }
    }
    throw new WebError('Codex Web Search exhausted its retry policy', 'CODEX_SEARCH_UPSTREAM')
  }
}

/** Cordis plugin name for the independent Search row. */
export const name = 'codex-search'
export const inject = ['web', 'codexAuth']

/** Register the Global Codex Search Provider with independently live settings. */
export function apply(ctx: Context, config: Config): void {
  const auth = ctx.get('codexAuth') as CodexAuthService | undefined
  if (auth === undefined) throw new Error('codex-search: shared codexAuth service is unavailable')
  let current = (): CodexSearchSettings => config
  installSettingsSection(ctx, CODEX_SEARCH_SETTINGS_NAMESPACE, Config, config, {
    setSource: source => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new CodexSearchProvider({
    auth,
    settings: () => current(),
    fetchImpl: fetch,
    requestId: () => String(ctx.get('agents')?.currentInitiator()?.id ?? randomUUID()),
    initiatingModel: () => initiatingCodexModel(ctx),
  }))
}

function initiatingCodexModel(ctx: Context): string | undefined {
  const agent = ctx.get('agents')?.currentInitiator()
  if (agent === undefined) return undefined
  const config = agent.session.requestHeader()?.config
  const provider = config?.provider ?? agent.options.provider
  const model = config?.model ?? agent.options.model
  return provider === CODEX_ROUTE && typeof model === 'string' && model.length > 0 ? model : undefined
}

function normalizeSearchResponse(value: unknown): WebSearchResult {
  if (!isRecord(value) || typeof value.output !== 'string') {
    throw new WebError('Codex Web Search returned an unusable response envelope', 'CODEX_SEARCH_RESPONSE')
  }
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  if (Array.isArray(value.results)) {
    for (const candidate of value.results) {
      if (!isRecord(candidate)) continue
      const rawUrl = trustedString(candidate.url, 8192) ?? trustedString(candidate.source_url, 8192)
      const url = rawUrl === undefined ? undefined : httpUrl(rawUrl)
      if (url === undefined || seen.has(url)) continue
      seen.add(url)
      const title = trustedString(candidate.title, 1000) ?? trustedString(candidate.source_title, 1000)
      const snippet = trustedString(candidate.snippet, 4000) ?? trustedString(candidate.text, 4000)
      sources.push({
        url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
      })
    }
  }
  return { content: value.output, sources, truncated: false }
}

function trustedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0 || text.length > maxLength || hasControlCharacter(text)) return undefined
  return text
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) || 0) < 0x20) return true
  }
  return false
}

function httpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* discard best-effort */ }
}

function throwIfAborted(signal: AbortSignal | undefined, code: string): void {
  if (signal?.aborted === true) throw cancelledError(code, signal)
}

function cancelledError(code: string, _signal: AbortSignal): WebError {
  return new WebError('Codex Web Search was cancelled', code)
}

function abortableDelay(ms: number, signal: AbortSignal | undefined, code: string): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal, code)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = (): void => { cleanup(); reject(cancelledError(code, signal as AbortSignal)) }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
