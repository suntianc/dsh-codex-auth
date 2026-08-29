// @vitest-environment jsdom
/** Stock rc.2 presentation of one plugin-owned Dual Checkpoint. */
import type {
  ClientBootstrapModule,
  ClientBundleRegistration,
  ClientModuleCreateOptions,
  ClientModuleLoaderTarget,
  DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { fireEvent, render } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeCodexNativeCheckpoint } from '../src/native-checkpoint.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const CONVERSATION_ID = '@deepseek-ai/dsh-client-ui-conversation'
const CONVERSATION_URL = '/plugins/conversation/client.js'
const TRAJECTORY_ID = '@deepseek-ai/dsh-client-ui-trajectory'
const TRAJECTORY_URL = '/plugins/trajectory/client.js'
const win = globalThis as DshWindow

interface StockClientExports extends Record<string, unknown> {
  apply(ctx: unknown): void
}

interface ConversationDefinition {
  readonly kind: string
  update(context: { state: unknown }, match: unknown): unknown
  buildViewNode(context: Record<string, unknown>): unknown
}

afterEach(() => {
  delete win.__ModuleLoader__
  for (const element of document.querySelectorAll('style[data-plugin]')) element.remove()
  vi.restoreAllMocks()
})

function staticHook<Value>(value: Value) {
  return <Selected>(selector: (snapshot: Value) => Selected): Selected => selector(value)
}

function runtimeModule(): Record<string, unknown> {
  return {
    defineStore: () => () => ({}),
    isReplacementSurfaceEvent: (event: { surfaceOp?: unknown }) => (
      event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    ),
    createSnapshotStore<Value>(initial: Value) {
      let value = initial
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => value,
        subscribe(listener: () => void) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next: Value) {
          value = next
          for (const listener of listeners) listener()
        },
      }
    },
    emptyAssistantBlock: vi.fn(),
    toAssistantBlock: vi.fn(),
    toAssistantBlocks: vi.fn(() => []),
    isTokenDelta: vi.fn(() => false),
    displayFailureMessage: vi.fn(() => ''),
    contextProvenance: vi.fn(),
    contextForm: vi.fn(),
  }
}

function primitivesModule(): Record<string, unknown> {
  return new Proxy({
    extractMarkdownPlainText: (value: string) => value,
    MarkdownText: ({ text }: { text: string }) => createElement('span', null, text),
    JsonTree: ({ data }: { data: unknown }) => createElement('pre', null, JSON.stringify(data)),
    Tooltip: ({ children }: { children: unknown }) => children,
  } as Record<string, unknown>, {
    get(target, key) {
      if (typeof key === 'string' && key in target) return target[key]
      return () => null
    },
  })
}

/** Load the published client through DSH's documented browser module-system contract. */
async function loadStockClients(): Promise<{
  readonly conversation: StockClientExports
  readonly trajectory: StockClientExports
}> {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration) },
    create() { throw new Error('client module bootstrap has not materialized') },
  }
  win.__ModuleLoader__ = target
  await import('@deepseek-ai/dsh-client-modules/client')

  const registrationIndex = pendingQueue.findIndex(entry => entry.id === MODULES_ID)
  const registration = pendingQueue[registrationIndex]
  if (registration === undefined) throw new Error('client module bootstrap did not register')
  pendingQueue.splice(registrationIndex, 1)
  const bootstrapExports = registration.factory((specifier) => {
    throw new Error(`unexpected bootstrap dependency: ${specifier}`)
  })
  const createClientModuleSystem = bootstrapExports.createClientModuleSystem
  if (typeof createClientModuleSystem !== 'function') {
    throw new TypeError('client module bootstrap has no createClientModuleSystem export')
  }
  target.create = (options: ClientModuleCreateOptions) => (
    createClientModuleSystem(
      target,
      { id: MODULES_ID, exports: bootstrapExports } satisfies ClientBootstrapModule,
      options,
    ) as ReturnType<ClientModuleLoaderTarget['create']>
  )

  const staticModules = {
    '@deepseek-ai/dsh-client-runtime/client': runtimeModule(),
    '@deepseek-ai/dsh-client-ui-slots': {
      resolveSlotLabel: (label: unknown) => typeof label === 'function' ? label() : label,
    },
    '@deepseek-ai/cordis': await import('@deepseek-ai/cordis'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react': await import('react'),
    'react-dom': await import('react-dom'),
    '@deepseek-ai/dsh-client-ui-primitives': primitivesModule(),
  }
  const loader = target.create({
    boot: {
      rev: 'dual-checkpoint-presentation',
      entries: [
        {
          id: CONVERSATION_ID,
          url: CONVERSATION_URL,
          rev: '0.1.1-rc.2',
          external: Object.keys(staticModules),
        },
        {
          id: TRAJECTORY_ID,
          url: TRAJECTORY_URL,
          rev: '0.1.1-rc.2',
          external: Object.keys(staticModules),
        },
      ],
      batches: [],
    },
    staticModules,
    loadBundle: async (url) => {
      if (url === CONVERSATION_URL) {
        await import('@deepseek-ai/dsh-client-ui-conversation/client')
        return
      }
      if (url === TRAJECTORY_URL) {
        await import('@deepseek-ai/dsh-client-ui-trajectory/client')
        return
      }
      throw new Error(`unexpected client bundle: ${url}`)
    },
  })
  const load = async (id: string): Promise<StockClientExports> => {
    const exports = await loader.import(id)
    if (typeof exports !== 'object' || exports === null
      || typeof (exports as { apply?: unknown }).apply !== 'function') {
      throw new TypeError(`published client ${id} has no apply export`)
    }
    return exports as StockClientExports
  }
  return {
    conversation: await load(CONVERSATION_ID),
    trajectory: await load(TRAJECTORY_ID),
  }
}

function nativeCheckpointBlock() {
  return encodeCodexNativeCheckpoint({
    schemaVersion: 1,
    codec: { kind: 'openai-responses-v2', generation: 1 },
    retention: { policy: 'codex-v2-retained-message-groups', generation: 1 },
    provenance: {
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      accountHash: `sha256:${'a'.repeat(64)}`,
    },
    compatibilityDigest: `sha256:${'b'.repeat(64)}`,
    replay: { estimator: 'codex-v2-json-bytes-div-4-v1', estimatedTokens: 1 },
    replacementItems: [{
      type: 'compaction',
      encrypted_content: 'opaque-presentation-state',
    }],
  })
}

function renderTrajectoryCheckpoint(trajectoryClient: StockClientExports) {
  let trajectoryView: unknown
  const ctx = {
    conversationEvents: { register: () => () => {} },
    conversationViews: { register: () => () => {} },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    sessions: {
      binding: () => ({
        session: {
          getSnapshot: () => ({}),
          loadOlder: () => Promise.resolve(),
        },
      }),
    },
    slots: {
      inject(_name: string, register: () => () => void) { return register() },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.id === 'trajectory') trajectoryView = component
        return () => {}
      },
    },
    effect(effect: () => (() => void)) { return effect() },
  }
  trajectoryClient.apply(ctx)
  if (trajectoryView === undefined) throw new Error('trajectory view was not registered')

  const nativeBlock = nativeCheckpointBlock()
  const trajectory = {
    eventNodes: [],
    eventLocations: new Map(),
    requests: [{
      purpose: 'compaction',
      startSeq: 1,
      turn: 1,
      step: 0,
      startedAt: 1_000,
      completedAt: 1_100,
      status: 'complete',
      resultSeq: 2,
      summary: [
        { type: 'text', text: 'PORTABLE TRAJECTORY SUMMARY' },
        nativeBlock,
      ],
      provenance: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      requestConfig: {
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        purpose: 'compaction',
      },
    }],
    callSchemas: new Map(),
    partial: null,
    runningCalls: [],
  }
  const session = {
    views: new Map([['trajectory', trajectory]]),
    openState: 'open',
    loadingOlder: false,
    hasMore: false,
  }
  return render(createElement(trajectoryView as ComponentType<Record<string, unknown>>, {
    useSession: staticHook(session),
    useDuration: staticHook(false),
    loadOlder: () => Promise.resolve(false),
    setActualDuration: () => {},
    onInspectDone: () => {},
    t: (key: string) => key,
  }))
}

function renderConversationCheckpoint(conversationClient: StockClientExports) {
  let compactionDefinition: ConversationDefinition | undefined
  let compactionView: unknown
  const registrationComplete = new Error('conversation registrations captured')
  const ctx = {
    conversationEvents: {
      register(definition: ConversationDefinition) {
        if (definition.kind === 'compaction') compactionDefinition = definition
        return () => {}
      },
      registerFallback: () => () => {},
    },
    conversationViews: { register: () => () => {} },
    slots: {
      inject(_name: string, register: () => () => void) { return register() },
      register(options: Record<string, unknown>, component: unknown) {
        if (options.name === 'conversation.chat.node' && options.key === 'compaction') {
          compactionView = component
        }
        return () => {}
      },
    },
    effect: () => { throw registrationComplete },
  }
  try {
    conversationClient.apply(ctx)
  } catch (error) {
    if (error !== registrationComplete) throw error
  }
  if (compactionDefinition === undefined || compactionView === undefined) {
    throw new Error('conversation compaction projection did not register')
  }

  const summaryMatch = {
    event: {
      type: 'compaction/summary',
      seq: 1,
      time: 1_000,
      data: {
        compactionId: 'cmp-presentation',
        summary: [
          { type: 'text', text: 'PORTABLE CONVERSATION SUMMARY' },
          nativeCheckpointBlock(),
        ],
      },
    },
    location: { kind: 'loaded', index: 0 },
  }
  const checkpointMatch = {
    event: {
      type: 'user/message',
      seq: 2,
      time: 1_100,
      surfaceOp: 'replace',
      data: {
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'cmp-presentation',
        },
      },
    },
    location: { kind: 'loaded', index: 1 },
  }
  let state: unknown = {}
  state = compactionDefinition.update({ state }, summaryMatch)
  state = compactionDefinition.update({ state }, checkpointMatch)
  const node = compactionDefinition.buildViewNode({
    key: 'compaction:cmp-presentation',
    id: 'cmp-presentation',
    state,
    matches: [summaryMatch, checkpointMatch],
  })
  const rendered = render(createElement(compactionView as ComponentType<Record<string, unknown>>, {
    node,
    t: (key: string) => key,
  }))
  fireEvent.click(rendered.getByRole('button'))
  return rendered
}

describe('Dual Checkpoint stock client presentation', () => {
  it('shows only Portable content in Conversation and Trajectory', async () => {
    const clients = await loadStockClients()
    const conversation = renderConversationCheckpoint(clients.conversation)
    const trajectory = renderTrajectoryCheckpoint(clients.trajectory)

    expect(conversation.container.textContent).toContain('PORTABLE CONVERSATION SUMMARY')
    expect(trajectory.container.textContent).toContain('PORTABLE TRAJECTORY SUMMARY')
    for (const rendered of [conversation, trajectory]) {
      expect(rendered.container.textContent).not.toContain('opaque-presentation-state')
      expect(rendered.container.textContent).not.toContain('encrypted_content')
      expect(rendered.container.textContent).not.toContain('codex-native-checkpoint')
      rendered.unmount()
    }
  })
})
