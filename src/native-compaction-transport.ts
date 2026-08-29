import { randomUUID } from 'node:crypto'
import {
  MAX_CODEX_NATIVE_CHECKPOINT_BYTES,
} from './native-checkpoint.ts'
import type {
  CodexNativeCheckpointUsage,
  CodexResponsesItem,
  JsonValue,
} from './native-checkpoint.ts'
import {
  CODEX_NATIVE_DEFAULT_RATE_LIMIT_OPEN_MS,
  NativeCompactionFailure,
} from './native-compaction-breaker.ts'
import { isPlainJsonTree, isPlainRecord } from './json-tree.ts'

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const MAX_NATIVE_SSE_BYTES = MAX_CODEX_NATIVE_CHECKPOINT_BYTES + 256 * 1024
const PROCESS_INSTALLATION_ID = randomUUID()

export interface CodexNativeTransportRequest {
  readonly baseUrl?: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly fetchImpl: typeof fetch
  readonly timeoutMs: number
  readonly streamIdleTimeoutMs: number
}

export interface CodexNativeTransportCredential {
  readonly accessToken: string
  readonly accountId: string
}

export interface CodexNativeTransportOperation {
  readonly sessionId: string
  readonly windowId: string
}

export interface CodexNativeTransportResponse {
  readonly artifact: CodexResponsesItem
  readonly usage?: CodexNativeCheckpointUsage
  readonly ignoredOutputItems: number
  /** Ephemeral provider continuation; never encoded, logged, or persisted. */
  readonly turnState?: string
}

/** One no-retry v2 request using the existing Host fetch and timeout policy. */
export async function sendCodexNativeCompaction(
  request: CodexNativeTransportRequest,
  credential: CodexNativeTransportCredential,
  operation: CodexNativeTransportOperation,
  body: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<CodexNativeTransportResponse> {
  const headerTimeout = new AbortController()
  const headerTimer = request.timeoutMs > 0
    ? setTimeout(
        () => headerTimeout.abort(new NativeCompactionFailure('transient')),
        request.timeoutMs,
      )
    : undefined
  const fetchSignal = headerTimer === undefined
    ? signal
    : AbortSignal.any([signal, headerTimeout.signal])
  let response: Response
  try {
    response = await awaitWithSignal(request.fetchImpl(codexResponsesUrl(request.baseUrl), {
      method: 'POST',
      headers: buildCompactHeaders(request, credential, operation),
      body: JSON.stringify(body),
      signal: fetchSignal,
    }), fetchSignal)
  } catch {
    signal.throwIfAborted()
    throw new NativeCompactionFailure('transient')
  } finally {
    if (headerTimer !== undefined) clearTimeout(headerTimer)
  }
  signal.throwIfAborted()
  if (!response.ok) throw httpFailure(response)
  try {
    const decoded = await decodeNativeResponse(response, signal, request.streamIdleTimeoutMs)
    const turnState = response.headers.get('x-codex-turn-state')
    return turnState === null || turnState.length === 0
      ? decoded
      : { ...decoded, turnState }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof NativeCompactionFailure) throw error
    throw new NativeCompactionFailure('protocol')
  }
}

function awaitWithSignal<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void Promise.resolve(value).then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error)),
    )
  })
}

export function codexResponsesUrl(baseUrl?: string): string {
  const normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/u, '')
  if (normalized.endsWith('/codex/responses')) return normalized
  if (normalized.endsWith('/codex')) return `${normalized}/responses`
  return `${normalized}/codex/responses`
}

function buildCompactHeaders(
  request: CodexNativeTransportRequest,
  credential: CodexNativeTransportCredential,
  operation: CodexNativeTransportOperation,
): Headers {
  const headers = new Headers({
    accept: 'text/event-stream',
    authorization: `Bearer ${credential.accessToken}`,
    'chatgpt-account-id': credential.accountId,
    'content-type': 'application/json',
    'openai-beta': request.publicHeaders['openai-beta'] ?? 'responses=experimental',
    originator: 'dsh-codex-auth',
    'session-id': operation.sessionId,
    'user-agent': 'dsh-codex-auth (DeepSeek Harness)',
    'x-client-request-id': operation.sessionId,
    'x-codex-installation-id': PROCESS_INSTALLATION_ID,
    'x-codex-turn-metadata': JSON.stringify({
      installation_id: PROCESS_INSTALLATION_ID,
      session_id: operation.sessionId,
      thread_id: operation.sessionId,
      window_id: operation.windowId,
      request_kind: 'compaction',
      compaction: {
        trigger: 'manual',
        reason: 'manual',
        implementation: 'remote',
        phase: 'pre_commit',
        strategy: 'memento',
      },
    }),
    'x-codex-window-id': operation.windowId,
    'x-openai-subagent': 'compact',
  })
  const betaFeatures = request.publicHeaders['x-codex-beta-features']
  if (betaFeatures !== undefined) headers.set('x-codex-beta-features', betaFeatures)
  return headers
}

async function decodeNativeResponse(
  response: Response,
  signal: AbortSignal,
  streamIdleTimeoutMs: number,
): Promise<CodexNativeTransportResponse> {
  if (response.body === null) throw new NativeCompactionFailure('protocol')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  let completed = 0
  let lastEventType: string | undefined
  let usage: CodexNativeCheckpointUsage | undefined
  let ignoredOutputItems = 0
  const compactions: CodexResponsesItem[] = []

  const acceptEvent = (data: string): void => {
    if (data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new NativeCompactionFailure('protocol')
    }
    if (!isPlainJsonTree(parsed) || !isPlainRecord(parsed) || typeof parsed.type !== 'string') {
      throw new NativeCompactionFailure('protocol')
    }
    lastEventType = parsed.type
    if (parsed.type === 'error' || parsed.type === 'response.failed') {
      throw new NativeCompactionFailure('protocol')
    }
    if (parsed.type === 'response.output_item.done') {
      if (!isPlainRecord(parsed.item)) {
        throw new NativeCompactionFailure('protocol')
      }
      if (parsed.item.type === 'compaction') {
        if (typeof parsed.item.encrypted_content !== 'string'
          || parsed.item.encrypted_content.length === 0) {
          throw new NativeCompactionFailure('protocol')
        }
        compactions.push(structuredClone(parsed.item) as CodexResponsesItem)
      } else {
        ignoredOutputItems += 1
      }
      return
    }
    if (parsed.type === 'response.completed') {
      completed += 1
      if (completed !== 1
        || (isPlainRecord(parsed.response)
          && parsed.response.status !== undefined
          && parsed.response.status !== 'completed')) {
        throw new NativeCompactionFailure('protocol')
      }
      usage = responseUsage(parsed.response)
    }
  }

  try {
    while (true) {
      signal.throwIfAborted()
      const part = await readWithIdleTimeout(reader, signal, streamIdleTimeoutMs)
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_NATIVE_SSE_BYTES) {
        throw new NativeCompactionFailure('size')
      }
      buffer += decoder.decode(part.value, { stream: true })
      buffer = consumeSseEvents(buffer, acceptEvent)
    }
    buffer += decoder.decode()
    if (buffer.trim().length > 0) consumeSseEvents(`${buffer}\n\n`, acceptEvent)
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    signal.throwIfAborted()
    if (error instanceof NativeCompactionFailure) throw error
    throw new NativeCompactionFailure('transient')
  } finally {
    reader.releaseLock()
  }

  if (completed !== 1 || lastEventType !== 'response.completed' || compactions.length !== 1) {
    throw new NativeCompactionFailure('protocol')
  }
  return {
    artifact: compactions[0]!,
    ...(usage === undefined ? {} : { usage }),
    ignoredOutputItems,
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted()
  if (timeoutMs <= 0) return awaitWithSignal(reader.read(), signal)
  const idleTimeout = new AbortController()
  const timer = setTimeout(
    () => idleTimeout.abort(new NativeCompactionFailure('transient')),
    timeoutMs,
  )
  try {
    return await awaitWithSignal(
      reader.read(),
      AbortSignal.any([signal, idleTimeout.signal]),
    )
  } finally {
    clearTimeout(timer)
  }
}

function consumeSseEvents(buffer: string, accept: (data: string) => void): string {
  let remaining = buffer.replaceAll('\r\n', '\n')
  while (true) {
    const boundary = remaining.indexOf('\n\n')
    if (boundary === -1) return remaining
    const block = remaining.slice(0, boundary)
    remaining = remaining.slice(boundary + 2)
    const data = block.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /u, ''))
      .join('\n')
    if (data.length > 0) accept(data)
  }
}

function responseUsage(value: unknown): CodexNativeCheckpointUsage | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.usage)) return undefined
  const usage = value.usage
  if (!nonnegativeInteger(usage.input_tokens) || !nonnegativeInteger(usage.output_tokens)) {
    return undefined
  }
  const inputDetails = isPlainRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const outputDetails = isPlainRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined
  return {
    source: 'reported',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(nonnegativeInteger(inputDetails?.cached_tokens)
      ? { cacheReadTokens: inputDetails.cached_tokens }
      : {}),
    ...(nonnegativeInteger(outputDetails?.reasoning_tokens)
      ? { reasoningTokens: outputDetails.reasoning_tokens }
      : {}),
  }
}

function httpFailure(response: Response): NativeCompactionFailure {
  if (response.status === 401 || response.status === 403) {
    return new NativeCompactionFailure('auth')
  }
  if (response.status === 429) {
    return new NativeCompactionFailure(
      'rate-limit',
      parseRetryAfterMs(response.headers.get('retry-after')),
    )
  }
  if (response.status >= 500) return new NativeCompactionFailure('transient')
  return new NativeCompactionFailure('protocol')
}

function parseRetryAfterMs(value: string | null): number {
  if (value === null) return CODEX_NATIVE_DEFAULT_RATE_LIMIT_OPEN_MS
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return CODEX_NATIVE_DEFAULT_RATE_LIMIT_OPEN_MS
  return Math.max(0, date - Date.now())
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
