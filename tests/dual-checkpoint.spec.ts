import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { CodexAuthAdapter } from '../src/codex-auth-adapter.ts'
import type { CodexAuthAdapterOptions } from '../src/codex-auth-adapter.ts'
import { apply as applyCodexCompaction } from '../src/compaction.ts'
import {
  CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  decodeCodexNativeCheckpoint,
} from '../src/native-checkpoint.ts'

const MODEL = 'gpt-5.6-sol'
const ACCOUNT_ID = 'acct_dual_fixture'
const PORTABLE_SUMMARY = 'PORTABLE CHECKPOINT'
const HISTORY = 'durable history fact and implementation detail '.repeat(700)

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fakeAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body) as Record<string, unknown>
  }
  if (init?.body instanceof Uint8Array) {
    const encoding = new Headers(init.headers).get('content-encoding')
    const bytes = encoding === 'zstd' ? zstdDecompressSync(init.body) : init.body
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
  }
  throw new Error(`unexpected request body: ${Object.prototype.toString.call(init?.body)}`)
}

function eventStreamText(events: readonly unknown[]): string {
  return `${events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`
}

function eventStream(events: readonly unknown[]): Response {
  return new Response(eventStreamText(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function delayedEventStream(events: readonly unknown[], delayMs: number): Response {
  const bytes = new TextEncoder().encode(eventStreamText(events))
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes)
        controller.close()
      }, delayMs)
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function textResponse(text: string): Response {
  return eventStream([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_fixture',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        usage: {
          input_tokens: 120,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    },
  ])
}

function completionOnlyResponse(): Response {
  return eventStream([{
    type: 'response.completed',
    response: { id: 'resp_without_compaction', status: 'completed' },
  }])
}

type ProtocolFailureFixture =
  | 'error-event'
  | 'malformed-json'
  | 'missing-opaque'
  | 'multiple-artifacts'
  | 'truncated'
  | 'zero-artifacts'

function protocolFailureResponse(fixture: ProtocolFailureFixture): Response {
  const compaction = (id: string, encryptedContent?: string) => ({
    type: 'response.output_item.done',
    item: {
      type: 'compaction',
      id,
      ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
    },
  })
  const completed = {
    type: 'response.completed',
    response: { id: 'resp_protocol_fixture', status: 'completed' },
  }
  if (fixture === 'zero-artifacts') return completionOnlyResponse()
  if (fixture === 'multiple-artifacts') {
    return eventStream([
      compaction('cmp_protocol_one', 'opaque-one'),
      compaction('cmp_protocol_two', 'opaque-two'),
      completed,
    ])
  }
  if (fixture === 'malformed-json') {
    return new Response('data: {not-json}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  if (fixture === 'error-event') {
    return eventStream([{ type: 'error', error: { message: 'fixture failure' } }])
  }
  if (fixture === 'truncated') {
    return eventStream([compaction('cmp_protocol_truncated', 'opaque-truncated')])
  }
  return eventStream([compaction('cmp_protocol_missing'), completed])
}

function compactionResponse(
  encryptedContent = 'opaque-remote-checkpoint',
  delayMs = 0,
  withUsage = true,
): Response {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'ignored_message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'MUST NOT BE INSTALLED' }],
      },
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'compaction',
        id: 'cmp_remote_fixture',
        encrypted_content: encryptedContent,
        future_provider_field: { retained: true },
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_compaction_fixture',
        status: 'completed',
        ...(withUsage
          ? {
              usage: {
                input_tokens: 1000,
                output_tokens: 55,
                input_tokens_details: { cached_tokens: 400 },
                output_tokens_details: { reasoning_tokens: 21 },
              },
            }
          : {}),
      },
    },
  ]
  return delayMs > 0 ? delayedEventStream(events, delayMs) : eventStream(events)
}

interface CapturedRequest {
  readonly kind: 'portable' | 'native' | 'ordinary'
  readonly body: Record<string, unknown>
  readonly headers: Headers
  readonly url: string
}

interface DualHostOptions {
  readonly accountId?: string
  readonly nativeReply?: (attempt: number, init?: RequestInit) => Response | Promise<Response>
  readonly portableReply?: (attempt: number) => Response | Promise<Response>
  readonly onPayload?: CodexAuthAdapterOptions['onPayload']
  readonly compactionConfig?: BasicCompactionConfig
  readonly timeoutMs?: number
}

function mountDualCheckpointHost(options: DualHostOptions = {}): {
  readonly ctx: Context
  readonly requests: CapturedRequest[]
} {
  const ctx = new Context()
  context = ctx
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)

  const requests: CapturedRequest[] = []
  let nativeAttempts = 0
  let portableAttempts = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = requestBody(init)
    const wireInput = body.input as unknown[]
    const finalInput = wireInput.at(-1)
    const native = (finalInput as { type?: unknown } | undefined)?.type === 'compaction_trigger'
    const portable = !native && JSON.stringify(finalInput)
      .includes('You are now acting as a compaction engine')
    const kind = native ? 'native' : portable ? 'portable' : 'ordinary'
    requests.push({
      kind,
      body,
      headers: new Headers(init?.headers),
      url: String(input),
    })
    if (native) {
      nativeAttempts += 1
      return options.nativeReply?.(nativeAttempts, init) ?? compactionResponse()
    }
    if (portable) {
      portableAttempts += 1
      return options.portableReply?.(portableAttempts) ?? textResponse(PORTABLE_SUMMARY)
    }
    return textResponse('ordinary answer')
  }) as typeof fetch
  vi.stubGlobal('fetch', fetchMock)

  const accountId = options.accountId ?? ACCOUNT_ID
  const adapter = new CodexAuthAdapter(ctx, {
    auth: {
      credential: () => Promise.resolve({
        accessToken: fakeAccessToken(accountId),
        accountId,
      }),
    },
    authJsonPath: '/nonexistent/auth.json',
    credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
    refreshLeadMs: 5 * 60 * 1000,
    fetchImpl: fetchMock,
    displayName: 'OpenAI Codex (chatgpt)',
    settings: () => ({ longContextEnabled: false }),
    transport: 'sse',
    websocketConnectTimeoutMs: 1_000,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.onPayload === undefined ? {} : { onPayload: options.onPayload }),
  })
  ctx.llm.registerAdapter(['openai-codex'], adapter)
  applyCodexCompaction(ctx, {
    auto: false,
    maxTokens: 128,
    ...options.compactionConfig,
  })
  return { ctx, requests }
}

function closedConversation(id = 'dual-checkpoint'): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request turn ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: 'openai-codex', model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `${HISTORY}${turn}` }],
        source: { provider: 'openai-codex', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function retentionConversation(): Session {
  const session = Session.create(SessionId('dual-retention'))
  const exchanges = [
    { user: 'old retained candidate', assistant: 'a'.repeat(500_000) },
    {
      user: `prefix-that-must-be-truncated:${'🙂'.repeat(80_000)}`,
      assistant: 'b'.repeat(500_000),
    },
  ]
  for (const [index, exchange] of exchanges.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: exchange.user }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: 'openai-codex', model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: exchange.assistant }],
        source: { provider: 'openai-codex', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function openConversation(id: string): Session {
  const session = closedConversation(id)
  session.append('turn/start', { turn: 3 })
  return session
}

function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: 'openai-codex', model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
  } as unknown as Agent
}

function messageText(message: Message): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Consume the public stream through its terminal event.
  }
}

describe('Codex Dual Checkpoint manual tracer bullet', () => {
  it('creates one atomic Dual Checkpoint after Portable success and replays Native next', async () => {
    const { ctx, requests } = mountDualCheckpointHost()
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => undefined)
    const session = closedConversation()
    const beforeEventCount = session.events.length
    const flushSnapshots: string[][] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation((flushed) => {
      flushSnapshots.push(flushed.events
        .filter(event => event.type.startsWith('compaction/'))
        .map(event => event.type))
      return Promise.resolve(true)
    })

    const result = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('ignoredOutputItems=%d'),
      expect.any(String),
      'manual',
      'openai-responses-v2',
      1,
      MODEL,
      expect.any(Number),
      2,
      1,
      expect.any(Number),
      expect.any(Number),
      'reported',
      '1000',
      '55',
      '400',
      'unavailable',
      '21',
    )
    const responseDiagnostic = debug.mock.calls.find(
      call => String(call[0]).includes('event=response'),
    )!
    expect(responseDiagnostic[10]).toBe(
      new TextEncoder().encode('opaque-remote-checkpoint').byteLength,
    )
    expect(responseDiagnostic[9]).toBeGreaterThan(responseDiagnostic[10] as number)
    const diagnostics = JSON.stringify(debug.mock.calls)
    expect(diagnostics).toContain('event=eligibility')
    expect(diagnostics).toContain('event=attempt')
    expect(diagnostics).toContain('breakerState=%s')
    expect(diagnostics).toContain('dual-committed')
    expect(diagnostics).not.toContain('opaque-remote-checkpoint')
    expect(diagnostics).not.toContain(fakeAccessToken(ACCOUNT_ID))
    expect(diagnostics).not.toContain(HISTORY)
    expect(flushSnapshots).toEqual([[
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ]])
    const transaction = session.events.slice(beforeEventCount)
    const startEvent = transaction.find(event => event.type === 'compaction/start')
    expect(startEvent?.type === 'compaction/start'
      && diagnostics.includes(String(startEvent.data.compactionId))).toBe(true)
    expect(transaction.map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])

    const summaryEvent = transaction.find(event => event.type === 'compaction/summary')
    const checkpointEvent = transaction.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && isCompactCheckpointSource(event.data.source),
    )
    const nativeSummaryBlock = summaryEvent?.data.summary.find(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )
    const nativeCheckpointBlock = checkpointEvent?.data.content.find(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )
    expect(nativeSummaryBlock).toEqual(nativeCheckpointBlock)
    expect(nativeCheckpointBlock).toBeDefined()
    const decoded = decodeCodexNativeCheckpoint(nativeCheckpointBlock)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.checkpoint.provenance).toMatchObject({
      provider: 'openai-codex',
      model: MODEL,
    })
    expect(decoded.checkpoint.usage).toEqual({
      source: 'reported',
      inputTokens: 1000,
      outputTokens: 55,
      cacheReadTokens: 400,
      reasoningTokens: 21,
    })
    expect(decoded.checkpoint.replacementItems.at(-1)).toMatchObject({
      type: 'compaction',
      id: 'cmp_remote_fixture',
      encrypted_content: 'opaque-remote-checkpoint',
      future_provider_field: { retained: true },
    })
    expect(JSON.stringify(decoded.checkpoint.replacementItems)).not.toContain('MUST NOT BE INSTALLED')
    expect(JSON.stringify(decoded.checkpoint.replacementItems)).not.toContain('compaction_trigger')
    expect(nativeCheckpointBlock?.state).not.toContain(fakeAccessToken(ACCOUNT_ID))
    expect(nativeCheckpointBlock?.state).not.toContain(ACCOUNT_ID)
    expect(nativeCheckpointBlock?.state).not.toContain('authorization')
    expect(nativeCheckpointBlock?.state).not.toContain('x-codex-turn-state')

    const nativeRequest = requests[1]!
    expect(nativeRequest.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(Object.keys(nativeRequest.body).sort()).toEqual([
      'include',
      'input',
      'instructions',
      'model',
      'parallel_tool_calls',
      'prompt_cache_key',
      'store',
      'stream',
      'text',
      'tool_choice',
    ])
    expect((nativeRequest.body.input as unknown[]).at(-1)).toEqual({ type: 'compaction_trigger' })
    expect(JSON.stringify(nativeRequest.body)).not.toContain('You are now acting as a compaction engine')
    expect(nativeRequest.body).not.toHaveProperty('max_output_tokens')
    expect(nativeRequest.body).not.toHaveProperty('previous_response_id')
    expect(nativeRequest.body).not.toHaveProperty('context_management')
    expect(nativeRequest.body).toMatchObject({
      model: MODEL,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    })
    expect(nativeRequest.headers.get('authorization')).toBe(
      `Bearer ${fakeAccessToken(ACCOUNT_ID)}`,
    )
    expect(nativeRequest.headers.get('chatgpt-account-id')).toBe(ACCOUNT_ID)
    expect(nativeRequest.headers.get('originator')).toBe('dsh-codex-auth')
    expect(nativeRequest.headers.get('session-id')).toBe(String(session.id))
    expect(nativeRequest.headers.get('x-codex-installation-id')).toBeTruthy()
    expect(nativeRequest.headers.get('x-codex-window-id')).toBeTruthy()
    expect(nativeRequest.headers.has('x-codex-turn-state')).toBe(false)

    const derived = session.deriveMessages()
    expect(messageText(derived[0]!)).toContain(PORTABLE_SUMMARY)
    expect(messageText(derived[0]!)).not.toContain(HISTORY)

    await drain(ctx.llm.stream({
      provider: 'openai-codex',
      model: MODEL,
      messages: derived,
      sessionId: session.id,
    }))

    expect(requests.map(request => request.kind)).toEqual(['portable', 'native', 'ordinary'])
    const replayBody = requests[2]!.body
    expect(JSON.stringify(replayBody)).toContain('opaque-remote-checkpoint')
    expect(JSON.stringify(replayBody)).not.toContain(PORTABLE_SUMMARY)
    expect(JSON.stringify(replayBody)).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
    expect(JSON.stringify(replayBody)).not.toContain('compaction_trigger')
  })

  it('isolates concurrent manual compactions by session', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let arrivals = 0
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_concurrent_fixture',
      nativeReply: (_attempt, init) => {
        const sessionId = new Headers(init?.headers).get('session-id')!
        arrivals += 1
        if (arrivals === 2) release()
        return gate.then(() => compactionResponse(`opaque-${sessionId}`))
      },
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const firstSession = closedConversation('dual-concurrent-first')
    const secondSession = closedConversation('dual-concurrent-second')

    await Promise.all([
      ctx.compaction.compactNow(
        idleAgent(firstSession),
        new AbortController().signal,
      ),
      ctx.compaction.compactNow(
        idleAgent(secondSession),
        new AbortController().signal,
      ),
    ])

    expect(arrivals).toBe(2)
    expect(requests.filter(request => request.kind === 'portable')).toHaveLength(2)
    const nativeRequests = requests.filter(request => request.kind === 'native')
    expect(nativeRequests).toHaveLength(2)
    expect(nativeRequests.map(request => request.headers.get('session-id')).sort()).toEqual([
      firstSession.id,
      secondSession.id,
    ].sort())
    for (const [session, other] of [
      [firstSession, secondSession],
      [secondSession, firstSession],
    ] as const) {
      const checkpoint = session.deriveMessages().find(message =>
        isCompactCheckpointSource(message.source))
      const block = checkpoint?.content.find(
        content => content.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      )
      const decoded = decodeCodexNativeCheckpoint(block)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) throw new Error(decoded.reason)
      const replacement = JSON.stringify(decoded.checkpoint.replacementItems)
      expect(replacement).toContain(`opaque-${session.id}`)
      expect(replacement).not.toContain(`opaque-${other.id}`)
    }
  })

  it('expands an earlier Native Checkpoint before a consecutive v2 trigger', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_consecutive_fixture',
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = closedConversation('dual-consecutive')
    await ctx.compaction.compactNow(idleAgent(session), new AbortController().signal)

    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new facts after the first checkpoint' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 3, step: 1 })
    session.append('assistant/message', {
      turn: 3,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'new answer '.repeat(4_000) }],
        source: { provider: 'openai-codex', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    const second = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(second).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual([
      'portable', 'native', 'portable', 'native',
    ])
    for (const request of requests.slice(2)) {
      expect(JSON.stringify(request.body)).toContain('opaque-remote-checkpoint')
      expect(JSON.stringify(request.body)).not.toContain(PORTABLE_SUMMARY)
      expect(JSON.stringify(request.body)).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
    }
    expect((requests[3]!.body.input as unknown[]).at(-1))
      .toEqual({ type: 'compaction_trigger' })
    const durableNativeBlocks = session.deriveMessages().flatMap(message =>
      message.content.filter(block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE))
    expect(durableNativeBlocks).toHaveLength(1)
  })

  it('keeps automatic and explicit-region compaction Portable-only', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_manual_only_fixture',
    })
    const automaticSession = openConversation('dual-automatic')
    const automatic = await ctx.compaction.compactIfNeeded(
      idleAgent(automaticSession),
      'context-overflow',
      new AbortController().signal,
    )
    expect(automatic).not.toBeNull()

    const regionSession = openConversation('dual-region')
    const region = await ctx.compaction.compactRegion(
      regionSession.surface.nodes[0]!,
      regionSession.surface.nodes.at(-1)!,
      idleAgent(regionSession),
      new AbortController().signal,
    )
    expect(region).not.toBeNull()

    expect(requests.map(request => request.kind)).toEqual(['portable', 'portable'])
    for (const session of [automaticSession, regionSession]) {
      const checkpoint = session.deriveMessages().find(message =>
        isCompactCheckpointSource(message.source))
      expect(messageText(checkpoint!)).toContain(PORTABLE_SUMMARY)
      expect(checkpoint?.content.some(
        block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      )).toBe(false)
    }
  })

  it.each([
    {
      label: 'different summarization model',
      options: {
        accountId: 'acct_model_ineligible_fixture',
        compactionConfig: {
          summarizationProvider: 'openai-codex',
          summarizationModel: 'gpt-5.4',
        },
      } satisfies DualHostOptions,
    },
    {
      label: 'image-bearing final prefix',
      options: {
        accountId: 'acct_image_ineligible_fixture',
        onPayload: (payload: unknown) => {
          const body = structuredClone(payload) as Record<string, unknown>
          const input = body.input as Record<string, unknown>[]
          const first = input[0]!
          first.content = [
            ...(first.content as unknown[]),
            { type: 'input_image', image_url: 'data:image/png;base64,fixture' },
          ]
          return body
        },
      } satisfies DualHostOptions,
    },
  ])('keeps $label manual compaction Portable-only', async ({ label, options }) => {
    const { ctx, requests } = mountDualCheckpointHost(options)
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = closedConversation(`dual-ineligible-${label.replaceAll(' ', '-')}`)

    const result = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual(['portable'])
    const checkpoint = session.deriveMessages().find(message =>
      isCompactCheckpointSource(message.source))
    expect(messageText(checkpoint!)).toContain(PORTABLE_SUMMARY)
    expect(checkpoint?.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )).toBe(false)
  })

  it('derives v2 only from allowlisted final callback controls', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_allowlist_fixture',
      onPayload: payload => ({
        ...(payload as Record<string, unknown>),
        instructions: 'FINAL CALLBACK INSTRUCTIONS',
        tools: [{
          type: 'function',
          name: 'fixture_tool',
          description: 'fixture',
          parameters: { type: 'object', properties: {} },
        }],
        parallel_tool_calls: false,
        reasoning: { effort: 'high', summary: 'auto' },
        text: { verbosity: 'medium' },
        service_tier: 'priority',
        max_output_tokens: 999,
        previous_response_id: 'must-not-copy',
        background: true,
        context_management: [{ type: 'compaction', threshold: 1 }],
        metadata: { secret_route_fact: 'must-not-copy' },
      }),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    const result = await ctx.compaction.compactNow(
      idleAgent(closedConversation('dual-allowlist')),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(requests[1]!.body).toMatchObject({
      instructions: 'FINAL CALLBACK INSTRUCTIONS',
      tools: [{ type: 'function', name: 'fixture_tool' }],
      parallel_tool_calls: false,
      reasoning: { effort: 'high', summary: 'auto' },
      text: { verbosity: 'medium' },
      service_tier: 'priority',
    })
    expect(Object.keys(requests[1]!.body).sort()).toEqual([
      'include',
      'input',
      'instructions',
      'model',
      'parallel_tool_calls',
      'prompt_cache_key',
      'reasoning',
      'service_tier',
      'store',
      'stream',
      'text',
      'tool_choice',
      'tools',
    ])
    expect(JSON.stringify(requests[1]!.body)).not.toContain('must-not-copy')
  })

  it('applies the request timeout only to headers while an active SSE body continues', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_timeout_policy_fixture',
      timeoutMs: 5,
      nativeReply: () => compactionResponse('opaque-delayed-active-stream', 20),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = closedConversation('dual-timeout-policy')

    const result = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(session.deriveMessages().some(message => message.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    ))).toBe(true)
  })

  it('falls back after the 300-second per-read SSE idle timeout', async () => {
    vi.useFakeTimers()
    let markNativeStarted!: () => void
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve
    })
    try {
      const { ctx, requests } = mountDualCheckpointHost({
        accountId: 'acct_idle_timeout_fixture',
        nativeReply: () => {
          markNativeStarted()
          return new Response(new ReadableStream<Uint8Array>({
            start() {
              // The idle watchdog, not the fixture, must terminate this stream.
            },
          }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      })
      vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
      const session = closedConversation('dual-idle-timeout')
      const pending = ctx.compaction.compactNow(
        idleAgent(session),
        new AbortController().signal,
      )

      await nativeStarted
      await vi.advanceTimersByTimeAsync(300_001)
      const result = await pending

      expect(result).not.toBeNull()
      expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
      expect(session.deriveMessages().some(message => message.content.some(
        block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      ))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records unavailable usage without inventing native accounting', async () => {
    const { ctx } = mountDualCheckpointHost({
      accountId: 'acct_usage_unavailable_fixture',
      nativeReply: () => compactionResponse('opaque-without-usage', 0, false),
    })
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => undefined)
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = closedConversation('dual-usage-unavailable')

    await ctx.compaction.compactNow(idleAgent(session), new AbortController().signal)

    const checkpoint = session.deriveMessages().find(message =>
      isCompactCheckpointSource(message.source))
    const block = checkpoint?.content.find(
      content => content.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )
    const decoded = decodeCodexNativeCheckpoint(block)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.checkpoint.usage).toBeUndefined()
    expect(debug.mock.calls.some(call => call.includes('unavailable'))).toBe(true)
  })

  it('retains newest user groups and a safe boundary prefix under 64,000 tokens', async () => {
    const { ctx } = mountDualCheckpointHost({
      accountId: 'acct_retention_fixture',
      onPayload: payload => {
        const body = structuredClone(payload) as Record<string, unknown>
        const input = body.input as Record<string, unknown>[]
        const newestUser = input.filter(item => item.role === 'user')
          .findLast(item => !JSON.stringify(item).includes('acting as a compaction engine'))!
        newestUser.future_user_field = { preserved: true }
        const part = (newestUser.content as Record<string, unknown>[])[0]!
        part.future_part_field = ['preserved']
        return body
      },
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = retentionConversation()

    const result = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    const checkpoint = session.deriveMessages().find(message =>
      isCompactCheckpointSource(message.source))
    const block = checkpoint?.content.find(
      content => content.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )
    const decoded = decodeCodexNativeCheckpoint(block)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.reason)
    const retained = decoded.checkpoint.replacementItems.slice(0, -1)
    expect(retained).toHaveLength(1)
    expect(Math.ceil(new TextEncoder().encode(JSON.stringify(retained)).byteLength / 4))
      .toBeLessThanOrEqual(64_000)
    expect(retained[0]).toMatchObject({
      future_user_field: { preserved: true },
      content: [{ future_part_field: ['preserved'] }],
    })
    const retainedText = ((retained[0]!.content as { text: string }[])[0]!).text
    expect(retainedText.startsWith('prefix-that-must-be-truncated')).toBe(true)
    expect(retainedText.endsWith('🙂')).toBe(true)
    const finalCodeUnit = retainedText.charCodeAt(retainedText.length - 1)
    expect(finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF).toBe(false)
    expect(decoded.checkpoint.replacementItems.at(-1)?.type).toBe('compaction')
  })

  it('falls back atomically to Portable and opens after three transient native failures', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_transient_breaker_fixture',
      nativeReply: () => new Response(null, { status: 503 }),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const session = closedConversation(`dual-transient-${attempt}`)
      const result = await ctx.compaction.compactNow(
        idleAgent(session),
        new AbortController().signal,
      )

      expect(result).not.toBeNull()
      const checkpoint = session.deriveMessages().find(message =>
        isCompactCheckpointSource(message.source))
      expect(messageText(checkpoint!)).toContain(PORTABLE_SUMMARY)
      expect(checkpoint?.content.some(
        block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      )).toBe(false)
      expect(session.events.slice(-4).map(event => event.type)).toEqual([
        'compaction/start',
        'compaction/summary',
        'user/message',
        'compaction/end',
      ])
    }

    expect(requests.map(request => request.kind)).toEqual([
      'portable', 'native',
      'portable', 'native',
      'portable', 'native',
      'portable',
    ])

    const isolated = mountDualCheckpointHost({
      accountId: 'acct_transient_isolated_fixture',
    })
    vi.spyOn(isolated.ctx.sessions, 'flush').mockResolvedValue(true)
    const isolatedSession = closedConversation('dual-transient-account-isolated')
    await isolated.ctx.compaction.compactNow(
      idleAgent(isolatedSession),
      new AbortController().signal,
    )
    expect(isolated.requests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(isolatedSession.deriveMessages().some(message => message.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    ))).toBe(true)
  })

  it('never starts native generation when Portable summarization fails', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_portable_failure_fixture',
      portableReply: () => new Response('portable failure', { status: 400 }),
    })
    const session = closedConversation('dual-portable-failure')
    const beforeSurface = [...session.surface.nodes]
    const beforeMessages = session.deriveMessages()
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    await expect(ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )).rejects.toThrow()

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => request.kind === 'portable')).toBe(true)
    expect(session.surface.nodes).toEqual(beforeSurface)
    expect(session.deriveMessages()).toEqual(beforeMessages)
    expect(session.events.slice(-2).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
  })

  it('propagates cancellation during native generation and commits nothing', async () => {
    const controller = new AbortController()
    const cancellation = new Error('native cancellation fixture')
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_native_cancel_fixture',
      nativeReply: () => {
        controller.abort(cancellation)
        return Promise.reject(cancellation)
      },
    })
    const session = closedConversation('dual-native-cancel')
    const beforeSurface = [...session.surface.nodes]
    const beforeMessages = session.deriveMessages()
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    await expect(ctx.compaction.compactNow(
      idleAgent(session),
      controller.signal,
    )).rejects.toThrow('native cancellation fixture')

    expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(session.surface.nodes).toEqual(beforeSurface)
    expect(session.deriveMessages()).toEqual(beforeMessages)
    expect(session.events.slice(-2).map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/end',
    ])
    expect(flush).toHaveBeenCalledOnce()
  })

  it('reports strict-shrink fallback for a nonshrinking artifact', async () => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: 'acct_nonshrinking_fixture',
      nativeReply: () => compactionResponse('x'.repeat(200_000)),
    })
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => undefined)
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const session = closedConversation('dual-nonshrinking')

    const result = await ctx.compaction.compactNow(
      idleAgent(session),
      new AbortController().signal,
    )

    expect(result).not.toBeNull()
    expect(requests.map(request => request.kind)).toEqual(['portable', 'native'])
    const checkpoint = session.deriveMessages().find(message =>
      isCompactCheckpointSource(message.source))
    expect(messageText(checkpoint!)).toContain(PORTABLE_SUMMARY)
    expect(checkpoint?.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    )).toBe(false)
    expect(JSON.stringify(debug.mock.calls)).toContain('strict-shrink')
    expect(JSON.stringify(debug.mock.calls)).toContain('portable-committed')
  })

  it.each([
    ['checkpoint limit', 2 * 1024 * 1024 + 16_000],
    ['stream limit', 3 * 1024 * 1024],
  ] as const)('does not open the breaker for the %s oversize fallback', async (label, bytes) => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: `acct_oversize_${label.replace(' ', '_')}_fixture`,
      nativeReply: attempt => attempt === 1
        ? compactionResponse('x'.repeat(bytes))
        : compactionResponse(),
    })
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => undefined)
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const oversized = closedConversation('dual-over-2-MiB')
    const retry = closedConversation('dual-after-over-2-MiB')

    await ctx.compaction.compactNow(idleAgent(oversized), new AbortController().signal)
    await ctx.compaction.compactNow(idleAgent(retry), new AbortController().signal)

    expect(requests.map(request => request.kind)).toEqual([
      'portable', 'native',
      'portable', 'native',
    ])
    expect(JSON.stringify(debug.mock.calls)).toContain('reason=%s')
    expect(debug.mock.calls.some(call => call.includes('size'))).toBe(true)
    expect(oversized.deriveMessages().some(message => message.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    ))).toBe(false)
    expect(retry.deriveMessages().some(message => message.content.some(
      block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    ))).toBe(true)
  })

  it.each([
    ['numeric Retry-After', '2', 2_001],
    ['capped Retry-After', '999999', 60 * 60 * 1000 + 1],
  ] as const)('reopens a 429 breaker after the %s delay', async (label, retryAfter, advanceMs) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: `acct_rate_limit_${label.replaceAll(' ', '_')}_fixture`,
      nativeReply: attempt => attempt === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': retryAfter } })
        : compactionResponse(),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    try {
      const first = closedConversation(`dual-rate-first-${label}`)
      await ctx.compaction.compactNow(idleAgent(first), new AbortController().signal)
      const blocked = closedConversation(`dual-rate-blocked-${label}`)
      await ctx.compaction.compactNow(idleAgent(blocked), new AbortController().signal)
      clock.mockReturnValue(10_000 + advanceMs)
      const probe = closedConversation(`dual-rate-probe-${label}`)
      await ctx.compaction.compactNow(idleAgent(probe), new AbortController().signal)

      expect(requests.map(request => request.kind)).toEqual([
        'portable', 'native',
        'portable',
        'portable', 'native',
      ])
      const probeCheckpoint = probe.deriveMessages().find(message =>
        isCompactCheckpointSource(message.source))
      expect(probeCheckpoint?.content.some(
        block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      )).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  it.each([
    'zero-artifacts',
    'multiple-artifacts',
    'malformed-json',
    'error-event',
    'truncated',
    'missing-opaque',
  ] as const)('opens immediately on a %s protocol failure', async (fixture) => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: `acct_protocol_${fixture}_fixture`,
      nativeReply: () => protocolFailureResponse(fixture),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await ctx.compaction.compactNow(
        idleAgent(closedConversation(`dual-protocol-${fixture}-${attempt}`)),
        new AbortController().signal,
      )
    }

    expect(requests.filter(request => request.kind === 'portable')).toHaveLength(2)
    expect(requests.filter(request => request.kind === 'native')).toHaveLength(1)
  })

  it.each([401, 403])('does not count HTTP %i authentication failures in the breaker', async (status) => {
    const { ctx, requests } = mountDualCheckpointHost({
      accountId: `acct_auth_failure_${status}_fixture`,
      nativeReply: () => new Response(null, { status }),
    })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await ctx.compaction.compactNow(
        idleAgent(closedConversation(`dual-auth-${attempt}`)),
        new AbortController().signal,
      )
    }

    expect(requests.filter(request => request.kind === 'portable')).toHaveLength(4)
    expect(requests.filter(request => request.kind === 'native')).toHaveLength(4)
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls.every(call => String(call[0]).includes('codex login'))).toBe(true)
  })
})
