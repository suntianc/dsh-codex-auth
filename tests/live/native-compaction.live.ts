import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAuthJsonPath } from '../../src/codex-auth.ts'
import { CodexAuthAdapter } from '../../src/codex-auth-adapter.ts'
import { CodexAuthService } from '../../src/codex-auth-service.ts'
import { apply as applyCodexCompaction } from '../../src/compaction.ts'
import {
  CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  decodeCodexNativeCheckpoint,
} from '../../src/native-checkpoint.ts'

const CONFIRMATION = 'I_UNDERSTAND_CODEX_LIVE_QUOTA'
const LIVE_FETCH = globalThis.fetch
const MODEL = process.env.DSH_CODEX_NATIVE_LIVE_MODEL || 'gpt-5.6-sol'
const PROMPT_SENTINEL = 'LIVE_NATIVE_PROMPT_SENTINEL'

if (process.env.CI) {
  throw new Error('native compaction live test refuses to run when CI is set')
}
if (process.env.DSH_CODEX_NATIVE_LIVE !== '1'
  || process.env.DSH_CODEX_NATIVE_LIVE_CONFIRM !== CONFIRMATION) {
  throw new Error('native compaction live test was not explicitly authorized')
}

interface TransportObservation {
  readonly kind: 'native' | 'ordinary' | 'portable' | 'unparsed'
  readonly payloadBytes: number
  readonly containsExpectedNative: boolean
  readonly containsPortableFallback: boolean
  readonly hasTurnStateHeader: boolean
}

class RedactedTransportProbe {
  readonly observations: TransportObservation[] = []
  expectedNative: string | undefined
  portableFallback: string | undefined

  readonly fetch: typeof fetch

  constructor(fetchImpl: typeof fetch) {
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      if (body === undefined) {
        this.observations.push({
          kind: 'unparsed',
          payloadBytes: requestBytes(init),
          containsExpectedNative: false,
          containsPortableFallback: false,
          hasTurnStateHeader: new Headers(init?.headers).has('x-codex-turn-state'),
        })
      } else {
        const serialized = JSON.stringify(body)
        const inputItems = Array.isArray(body.input) ? body.input : []
        const finalItem = inputItems.at(-1)
        const native = isRecord(finalItem) && finalItem.type === 'compaction_trigger'
        const portable = !native && serialized.includes('acting as a compaction engine')
        this.observations.push({
          kind: native ? 'native' : portable ? 'portable' : 'ordinary',
          payloadBytes: requestBytes(init),
          containsExpectedNative: this.expectedNative !== undefined
            && serialized.includes(this.expectedNative),
          containsPortableFallback: this.portableFallback !== undefined
            && serialized.includes(this.portableFallback),
          hasTurnStateHeader: new Headers(init?.headers).has('x-codex-turn-state'),
        })
      }
      return fetchImpl(input, init)
    }) as typeof fetch
  }

  clearSensitiveExpectations(): void {
    this.expectedNative = undefined
    this.portableFallback = undefined
  }
}

interface LiveHost {
  readonly auth: CodexAuthService
  readonly ctx: Context
  readonly diagnosticCalls: unknown[][]
  readonly probe: RedactedTransportProbe
}

function mountLiveHost(automatic = false): LiveHost {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const probe = new RedactedTransportProbe(LIVE_FETCH)
  vi.stubGlobal('fetch', probe.fetch)
  const authJsonPath = defaultAuthJsonPath()
  const auth = new CodexAuthService(ctx, {
    authJsonPath,
    codexCommand: 'codex',
    credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
    fetchImpl: probe.fetch,
  })
  const adapter = new CodexAuthAdapter(ctx, {
    auth,
    authJsonPath,
    credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
    refreshLeadMs: 5 * 60 * 1000,
    fetchImpl: probe.fetch,
    displayName: 'OpenAI Codex (chatgpt)',
    settings: () => ({ longContextEnabled: false }),
    transport: 'sse',
    websocketConnectTimeoutMs: 5_000,
    timeoutMs: 120_000,
  })
  ctx.llm.registerAdapter(['openai-codex'], adapter)
  applyCodexCompaction(ctx, automatic
    ? {
        auto: true,
        thresholdRatio: 0.2,
        retainTokens: 64,
        compactionRetries: 0,
        maxTokens: 512,
      }
    : { auto: false, maxTokens: 512 })
  vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const diagnosticCalls: unknown[][] = []
  vi.spyOn(ctx.logger, 'debug').mockImplementation((...args: unknown[]) => {
    diagnosticCalls.push(args)
  })
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    diagnosticCalls.push(args)
  })
  return { auth, ctx, diagnosticCalls, probe }
}

function liveHistory(id: string): Session {
  const session = Session.create(SessionId(id))
  appendLargeTurn(session, 1, 'first')
  appendLargeTurn(session, 2, 'second')
  return session
}

function appendLargeTurn(session: Session, turn: number, label: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${PROMPT_SENTINEL}:${label}` }],
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
      content: [{
        type: 'text',
        text: `${label} retained history ${'provider continuity evidence '.repeat(5_000)}`,
      }],
      source: { provider: 'openai-codex', model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
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

function checkpointState(session: Session): {
  readonly nativeOpaque: string
  readonly portableFallback: string
} {
  const message = session.deriveMessages().find(candidate => candidate.content.some(
    block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  ))
  const block = message?.content.find(
    candidate => candidate.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  )
  const decoded = decodeCodexNativeCheckpoint(block)
  expect(decoded.ok).toBe(true)
  if (!decoded.ok) throw new Error(decoded.reason)
  const artifact = decoded.checkpoint.replacementItems.at(-1)
  expect(artifact?.type).toBe('compaction')
  expect(typeof artifact?.encrypted_content).toBe('string')
  const portableFallback = message?.content
    .filter(candidate => candidate.type === 'text')
    .map(candidate => candidate.text)
    .join('') ?? ''
  if (typeof artifact?.encrypted_content !== 'string' || portableFallback.length === 0) {
    throw new Error('live Dual Checkpoint lacked one Native artifact and Portable fallback')
  }
  return { nativeOpaque: artifact.encrypted_content, portableFallback }
}

async function consume(stream: AsyncIterable<unknown>): Promise<number> {
  let chunks = 0
  for await (const _chunk of stream) chunks += 1
  return chunks
}

function requestBody(init?: RequestInit): Record<string, unknown> | undefined {
  try {
    if (typeof init?.body === 'string') {
      return JSON.parse(init.body) as Record<string, unknown>
    }
    if (init?.body instanceof Uint8Array) {
      const headers = new Headers(init.headers)
      const bytes = headers.get('content-encoding') === 'zstd'
        ? zstdDecompressSync(init.body)
        : init.body
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function requestBytes(init?: RequestInit): number {
  if (typeof init?.body === 'string') return Buffer.byteLength(init.body)
  return init?.body instanceof Uint8Array ? init.body.byteLength : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hosts: LiveHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.probe.clearSensitiveExpectations()
    await host.ctx.fiber.dispose()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('credential-gated Codex Native compaction live boundary', () => {
  it('covers v2, same-process continuation, restart/resume, repeated compaction, and redacted diagnostics', async () => {
    const first = mountLiveHost(true)
    hosts.push(first)
    const credential = await first.auth.credential(AbortSignal.timeout(120_000))
    if (credential === undefined) {
      throw new Error('Codex Login State is unavailable; run "codex login" before the live harness')
    }
    if (credential.accountId === undefined || credential.accountId.length === 0) {
      throw new Error('Codex Login State has no account identity required by Native compaction')
    }
    const session = liveHistory(`native-live-${Date.now()}`)
    session.append('turn/start', { turn: 3 })
    const agent = idleAgent(session)

    await agentEvents(first.ctx, agent).waterfall('agent/pre-step', {
      messages: [],
      turn: 3,
      step: 1,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    const firstState = checkpointState(session)
    first.probe.expectedNative = firstState.nativeOpaque
    first.probe.portableFallback = firstState.portableFallback
    const continuationChunks = await consume(first.ctx.llm.stream(markAgentLoopRequest(deepFreeze({
      provider: 'openai-codex',
      model: MODEL,
      messages: session.deriveMessages(),
      sessionId: session.id,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    }))))
    expect({
      continuationChunks,
      observations: first.probe.observations,
    }).toMatchObject({
      continuationChunks: expect.any(Number),
      observations: [
        expect.objectContaining({ kind: 'portable' }),
        expect.objectContaining({ kind: 'native' }),
        expect.objectContaining({ kind: 'ordinary' }),
      ],
    })
    expect(continuationChunks).toBeGreaterThan(0)
    expect(first.probe.observations.slice(-1)).toEqual([
      expect.objectContaining({
        kind: 'ordinary',
        containsExpectedNative: true,
        containsPortableFallback: false,
        hasTurnStateHeader: true,
      }),
    ])
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    const persisted = JSON.parse(JSON.stringify({
      events: session.snapshotEvents(),
      header: session.header,
      inheritedEventCount: session.inheritedEventCount,
    })) as {
      events: SessionEvent[]
      header: typeof session.header
      inheritedEventCount: typeof session.inheritedEventCount
    }
    first.probe.clearSensitiveExpectations()
    await first.ctx.fiber.dispose()
    hosts.splice(hosts.indexOf(first), 1)

    const resumedHost = mountLiveHost()
    hosts.push(resumedHost)
    const resumed = Session.fromRestore(
      session.id,
      persisted.events,
      persisted.header,
      persisted.inheritedEventCount,
    )
    resumedHost.probe.expectedNative = firstState.nativeOpaque
    resumedHost.probe.portableFallback = firstState.portableFallback
    await consume(resumedHost.ctx.llm.stream({
      provider: 'openai-codex',
      model: MODEL,
      messages: resumed.deriveMessages(),
      sessionId: resumed.id,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    }))
    expect(resumedHost.probe.observations.slice(-1)).toEqual([
      expect.objectContaining({
        kind: 'ordinary',
        containsExpectedNative: true,
        containsPortableFallback: false,
        hasTurnStateHeader: false,
      }),
    ])

    appendLargeTurn(resumed, 4, 'after-restart')
    await resumedHost.ctx.compaction.compactNow(
      idleAgent(resumed),
      AbortSignal.timeout(10 * 60 * 1000),
    )
    const repeatedState = checkpointState(resumed)
    const repeatedRequests = resumedHost.probe.observations.slice(-2)
    expect(repeatedRequests.map(request => request.kind)).toEqual(['portable', 'native'])
    expect(repeatedRequests.every(request => request.containsExpectedNative)).toBe(true)
    expect(repeatedState.nativeOpaque).not.toBe(firstState.nativeOpaque)

    const diagnostics = JSON.stringify([
      ...first.diagnosticCalls,
      ...resumedHost.diagnosticCalls,
    ])
    expect(diagnostics).not.toContain(credential.accessToken)
    if (credential.accountId !== undefined) {
      expect(diagnostics).not.toContain(credential.accountId)
    }
    expect(diagnostics).not.toContain(PROMPT_SENTINEL)
    expect(diagnostics).not.toContain(firstState.nativeOpaque)
    expect(diagnostics).not.toContain(repeatedState.nativeOpaque)
    expect(diagnostics).not.toContain('encrypted_content')
  })
})
