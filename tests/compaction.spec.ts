import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import {
  BasicCompactionEngine,
  type BasicCompactionConfig,
} from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  isCompactCheckpointSource,
  type CompactionResult,
} from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import {
  apply as applyCodexCompaction,
  assertCodexCompactionCompatibility,
  CODEX_COMPACTION_COMPATIBILITY,
  CodexCompactionEngine,
} from '../src/compaction.ts'

const MODEL = 'portable-model'
const HISTORY = 'older conversation history that must be summarized '.repeat(80)

let context: Context | undefined

/** Deterministic fake model used by both compaction and the next normal request. */
class PortableSummaryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly output = 'PORTABLE CHECKPOINT',
    private readonly contextWindow = 100_000,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const textIndex = options.purpose === 'compaction' ? 1 : 0
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'SERVER NATIVE-ONLY FIXTURE' },
      }
    }
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    yield {
      type: 'block-end',
      index: textIndex,
      block: { type: 'text', text: this.output },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Closed conversation with a provider-routed, compactable prefix. */
function closedConversation(): Session {
  const session = Session.create(SessionId('portable-checkpoint'))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${HISTORY}${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** Closed exchanges followed by one open turn for automatic compaction. */
function openConversation(): Session {
  const session = closedConversation()
  session.append('turn/start', { turn: 3 })
  return session
}

/** Idle Agent facade for the public manual-compaction Interface. */
function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
  } as unknown as Agent
}

/** Concatenate model-visible text without inspecting compaction internals. */
function messageText(message: Message): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Mount the public services shared by Basic and the experimental Adapter. */
function createCompactionHost(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  return ctx
}

/** Track one Host for afterEach disposal. */
function trackedCompactionHost(): Context {
  context = createCompactionHost()
  return context
}

/** Mount the custom Adapter with an optional fake model. */
function mountCodexCompaction(
  adapter?: LlmAdapter,
  config: BasicCompactionConfig = { auto: false },
): Context {
  const ctx = trackedCompactionHost()
  if (adapter !== undefined) ctx.llm.registerAdapter([MODEL], adapter)
  applyCodexCompaction(ctx, config)
  return ctx
}

type EngineConstructor = new (
  ctx: Context,
  config?: BasicCompactionConfig,
) => BasicCompactionEngine

interface ConformanceDefinition {
  readonly output?: string
  readonly config: BasicCompactionConfig
  readonly session: () => Session
  readonly cancel?: boolean
  readonly run: (
    engine: BasicCompactionEngine,
    agent: Agent,
    signal: AbortSignal,
  ) => Promise<CompactionResult | null>
}

const CONFORMANCE_SCENARIOS = {
  manual: {
    config: { auto: false, maxTokens: 128 },
    session: closedConversation,
    run: (engine, agent, signal) => engine.compactNow(agent, signal),
  },
  pressure: {
    config: {
      auto: false,
      thresholdRatio: 0.0125,
      retainTokens: 32,
      maxTokens: 128,
      compactionRetries: 0,
    },
    session: openConversation,
    run: (engine, agent, signal) => engine.compactIfNeeded(agent, 'pressure', signal),
  },
  'context-overflow': {
    config: { auto: false, maxTokens: 128 },
    session: openConversation,
    run: (engine, agent, signal) => engine.compactIfNeeded(agent, 'context-overflow', signal),
  },
  cancellation: {
    config: { auto: false, maxTokens: 128 },
    session: openConversation,
    cancel: true,
    run: (engine, agent, signal) => engine.compactIfNeeded(agent, 'context-overflow', signal),
  },
  'strict-shrink': {
    output: 'X'.repeat(50_000),
    config: { auto: false, maxTokens: 50_000 },
    session: openConversation,
    run: (engine, agent, signal) => engine.compactIfNeeded(agent, 'context-overflow', signal),
  },
} satisfies Record<string, ConformanceDefinition>

type ConformanceScenario = keyof typeof CONFORMANCE_SCENARIOS
const CONFORMANCE_SCENARIO_NAMES = Object.keys(CONFORMANCE_SCENARIOS) as ConformanceScenario[]

/** Observe only public/session-visible facts so random transaction ids do not mask parity. */
async function observeCompaction(
  Engine: EngineConstructor,
  scenario: ConformanceScenario,
): Promise<unknown> {
  const definition: ConformanceDefinition = CONFORMANCE_SCENARIOS[scenario]
  const ctx = createCompactionHost()
  const adapter = new PortableSummaryAdapter(definition.output)
  ctx.llm.registerAdapter([MODEL], adapter)
  const engine = new Engine(ctx, definition.config)
  const session = definition.session()
  const beforeEventCount = session.events.length
  let flushes = 0
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(() => {
    flushes += 1
    return Promise.resolve(true)
  })
  const controller = new AbortController()
  if (definition.cancel === true) controller.abort(new Error('fixture cancellation'))

  try {
    let outcome: unknown
    try {
      const result = await definition.run(engine, idleAgent(session), controller.signal)
      outcome = result === null
        ? { kind: 'null' }
        : {
            kind: 'result',
            startSeq: result.startSeq,
            summarySeq: result.summarySeq,
            endSeq: result.endSeq,
            shadowedRange: result.shadowedRange,
            shadowedSeqs: result.shadowedSeqs,
            shadowedTokenCount: result.shadowedTokenCount,
            summary: result.summary,
          }
    } catch (error: unknown) {
      outcome = error instanceof Error
        ? { kind: 'error', name: error.name, message: error.message }
        : { kind: 'error', name: typeof error, message: String(error) }
    }

    const transaction = session.events.slice(beforeEventCount)
    const checkpoint = transaction.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && isCompactCheckpointSource(event.data.source),
    )
    return {
      outcome,
      events: transaction.map(event => ({
        type: event.type,
        surfaceOp: 'surfaceOp' in event ? event.surfaceOp : undefined,
        sourceEventSeqs: 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined,
        error: event.type === 'compaction/end' && event.data.error !== undefined,
      })),
      checkpointSourceEventSeqs: checkpoint?.sourceEventSeqs,
      messages: session.deriveMessages().map(messageText),
      requestPurposes: adapter.requests.map(request => request.purpose),
      flushes,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('Codex Portable Checkpoint Adapter', () => {
  it('selects one Basic-derived Adapter at the ctx.compaction Seam', () => {
    const ctx = mountCodexCompaction(undefined, { auto: false })

    expect(ctx.compaction).toBeInstanceOf(CodexCompactionEngine)
    expect(ctx.compaction).toBeInstanceOf(BasicCompactionEngine)
    expect((ctx.compaction as CodexCompactionEngine).config.auto).toBe(false)
    expect(CodexCompactionEngine.prototype.compactNow)
      .toBe(BasicCompactionEngine.prototype.compactNow)
    expect(CodexCompactionEngine.prototype.compactIfNeeded)
      .toBe(BasicCompactionEngine.prototype.compactIfNeeded)
    expect(CodexCompactionEngine.prototype.compactRegion)
      .toBe(BasicCompactionEngine.prototype.compactRegion)
  })

  it.each(CONFORMANCE_SCENARIO_NAMES)(
    'matches Basic public observations for %s',
    async (scenario) => {
      const baseline = await observeCompaction(BasicCompactionEngine, scenario)
      const experimental = await observeCompaction(CodexCompactionEngine, scenario)

      expect(experimental).toEqual(baseline)
    },
  )

  it('lands a durable Portable Checkpoint that survives the next normal request', async () => {
    const adapter = new PortableSummaryAdapter()
    const ctx = mountCodexCompaction(adapter, { auto: false, maxTokens: 128 })
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
    expect(flushSnapshots).toEqual([[
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ]])
    const transaction = session.events.slice(beforeEventCount)
    expect(transaction.map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    const summaryEvent = transaction.find(event => event.type === 'compaction/summary')
    expect(summaryEvent?.data.summary).toEqual([{ type: 'text', text: 'PORTABLE CHECKPOINT' }])
    expect(JSON.stringify(summaryEvent?.data.rawOutput)).toContain('SERVER NATIVE-ONLY FIXTURE')
    expect(summaryEvent?.data).not.toHaveProperty('nativeCheckpoint')
    const checkpoint = transaction.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && isCompactCheckpointSource(event.data.source),
    )
    expect(checkpoint?.sourceEventSeqs).toEqual([
      result?.startSeq,
      result?.summarySeq,
      ...result?.shadowedSeqs ?? [],
    ])
    const derived = session.deriveMessages()
    expect(messageText(derived[0]!)).toContain('<compacted-summary>')
    expect(messageText(derived[0]!)).toContain('PORTABLE CHECKPOINT')
    expect(messageText(derived[0]!)).not.toContain(HISTORY)
    expect(derived.map(messageText).join('\n')).not.toContain('SERVER NATIVE-ONLY FIXTURE')
    expect(adapter.requests[0]?.purpose).toBe('compaction')
    expect(adapter.requests[0]?.messages.map(messageText).join('\n')).toContain(HISTORY)

    for await (const _chunk of ctx.llm.stream({
      provider: MODEL,
      model: MODEL,
      messages: derived,
    })) {
      // Consume the public stream so the fake model observes the replay surface.
    }

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.purpose).toBeUndefined()
    expect(messageText(adapter.requests[1]!.messages[0]!)).toContain('PORTABLE CHECKPOINT')
    expect(adapter.requests[1]!.messages.map(messageText).join('\n'))
      .not.toContain('SERVER NATIVE-ONLY FIXTURE')
  })

  it.each([
    ['pressure', { thresholdRatio: 0.0125, retainTokens: 32 }],
    ['context-overflow', { thresholdRatio: 0.99, retainTokens: 32 }],
  ] as const)(
    'preserves Basic %s compaction through the public automatic Seam',
    async (trigger, policy) => {
      const adapter = new PortableSummaryAdapter()
      const ctx = mountCodexCompaction(adapter, {
        ...policy,
        auto: false,
        maxTokens: 128,
        compactionRetries: 0,
      })
      const session = openConversation()

      const result = await ctx.compaction.compactIfNeeded(
        idleAgent(session),
        trigger,
        new AbortController().signal,
      )

      expect(result).not.toBeNull()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.purpose).toBe('compaction')
      expect(session.events.slice(-4).map(event => event.type)).toEqual([
        'compaction/start',
        'compaction/summary',
        'user/message',
        'compaction/end',
      ])
      expect(messageText(session.deriveMessages()[0]!)).toContain('PORTABLE CHECKPOINT')
    },
  )

  it('preserves Basic strict-shrink rejection without replacing the surface', async () => {
    const ctx = mountCodexCompaction(
      new PortableSummaryAdapter('X'.repeat(50_000)),
      { auto: false, maxTokens: 50_000 },
    )
    const session = openConversation()
    const beforeSurface = [...session.surface.nodes]
    const beforeMessages = session.deriveMessages()

    await expect(ctx.compaction.compactIfNeeded(
      idleAgent(session),
      'context-overflow',
      new AbortController().signal,
    )).rejects.toThrow(/summary is not smaller than the shadowed content/)

    expect(session.surface.nodes).toEqual(beforeSurface)
    expect(session.deriveMessages()).toEqual(beforeMessages)
    expect(session.events.filter(event => event.type.startsWith('compaction/'))
      .map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
  })

  it('preserves Basic cancellation without landing a checkpoint', async () => {
    const ctx = mountCodexCompaction(new PortableSummaryAdapter())
    const session = openConversation()
    const beforeSurface = [...session.surface.nodes]
    const controller = new AbortController()
    controller.abort(new Error('fixture cancellation'))

    await expect(ctx.compaction.compactIfNeeded(
      idleAgent(session),
      'context-overflow',
      controller.signal,
    )).rejects.toThrow()

    expect(session.surface.nodes).toEqual(beforeSurface)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(false)
    expect(session.events.filter(event => event.type.startsWith('compaction/'))
      .map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
  })

  it('loads and exercises the shipped custom preset with one compaction Adapter', async () => {
    const adapter = new PortableSummaryAdapter('PORTABLE CHECKPOINT', 2_000)
    const ctx = trackedCompactionHost()
    ctx.llm.registerAdapter([MODEL], adapter)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === 'dsh-codex-auth/compaction') return import('../src/compaction.ts')
        if (specifier === '@deepseek-ai/dsh-command-compact') return import('@deepseek-ai/dsh-command-compact')
        if (specifier === '@deepseek-ai/dsh-compaction-tool-result-pruner') {
          return import('@deepseek-ai/dsh-compaction-tool-result-pruner')
        }
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const presetPath = resolve('examples/agent-presets/codex-portable/agent.cordis.yml')
    ctx.baseUrl = pathToFileURL(dirname(presetPath)).href + '/'

    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(presetPath).href },
    })
    await ctx.loader.await()

    const active = [...ctx.loader.entries()].filter(entry => entry.fiber !== undefined)
    expect(active.filter(entry => entry.options.name === 'dsh-codex-auth/compaction')).toHaveLength(1)
    expect(active.some(entry => entry.options.name === '@deepseek-ai/dsh-compaction-basic')).toBe(false)
    const compactionEntry = active.find(entry => entry.options.name === 'dsh-codex-auth/compaction')
    const loadedCompaction = compactionEntry?.ctx.get('compaction')
    expect(loadedCompaction).toBeInstanceOf(CodexCompactionEngine)
    expect(compactionEntry?.ctx.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(active.some(entry => entry.options.name === '@deepseek-ai/dsh-command-compact')).toBe(true)
    if (!(loadedCompaction instanceof CodexCompactionEngine)) {
      throw new Error('custom preset did not mount CodexCompactionEngine')
    }
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)

    const manualSession = closedConversation()
    const manual = await loadedCompaction.compactNow(
      idleAgent(manualSession),
      new AbortController().signal,
    )
    const automaticSession = openConversation()
    const automatic = await loadedCompaction.compactIfNeeded(
      idleAgent(automaticSession),
      'pressure',
      new AbortController().signal,
    )

    expect(manual).not.toBeNull()
    expect(automatic).not.toBeNull()
    expect(messageText(manualSession.deriveMessages()[0]!)).toContain('PORTABLE CHECKPOINT')
    expect(messageText(automaticSession.deriveMessages()[0]!)).toContain('PORTABLE CHECKPOINT')
    expect(adapter.requests.map(request => request.purpose)).toEqual(['compaction', 'compaction'])
  })

  it('fails loud when any experimental DSH runtime package leaves the pinned pair', () => {
    expect(CODEX_COMPACTION_COMPATIBILITY).toEqual({
      dsh: '0.1.1-rc.2',
      piAi: '0.82.1',
    })
    expect(() => assertCodexCompactionCompatibility({
      dsh: {
        '@deepseek-ai/dsh-agent': '0.1.1-rc.1',
        '@deepseek-ai/dsh-compaction': '0.1.1-rc.2',
        '@deepseek-ai/dsh-compaction-basic': '0.1.1-rc.2',
        '@deepseek-ai/dsh-llm': '0.1.1-rc.2',
        '@deepseek-ai/dsh-session': '0.1.1-rc.2',
        '@deepseek-ai/dsh-token-meter': '0.1.1-rc.2',
      },
      piAi: '0.82.1',
    })).toThrow(
      /requires DSH 0\.1\.1-rc\.2.*received @deepseek-ai\/dsh-agent=0\.1\.1-rc\.1/,
    )
  })
})
