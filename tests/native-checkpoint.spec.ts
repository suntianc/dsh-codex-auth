import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  defaultProviderAuthContext,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createUserMessage, deepFreeze, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { CodexAuthAdapter } from '../src/codex-auth-adapter.ts'
import type { CodexAuthAdapterOptions } from '../src/codex-auth-adapter.ts'
import {
  codexNativeCheckpointCompatibilityDigest,
  hashCodexAccountIdentity,
  isCodexNativeReplayRuntimeCompatible,
  CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  CODEX_NATIVE_REPLAY_COMPATIBILITY,
  MAX_CODEX_NATIVE_CHECKPOINT_BYTES,
  decodeCodexNativeCheckpoint,
  encodeCodexNativeCheckpoint,
  type CodexNativeCheckpointV1,
} from '../src/native-checkpoint.ts'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  }
})

const VALID_CHECKPOINT: CodexNativeCheckpointV1 = {
  schemaVersion: 1,
  codec: {
    kind: 'openai-responses-v2',
    generation: 1,
  },
  retention: {
    policy: 'codex-v2-retained-message-groups',
    generation: 1,
  },
  provenance: {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    accountHash: `sha256:${'a'.repeat(64)}`,
  },
  compatibilityDigest: `sha256:${'b'.repeat(64)}`,
  replay: {
    estimator: 'codex-v2-json-bytes-div-4-v1',
    estimatedTokens: 321,
  },
  usage: {
    source: 'reported',
    inputTokens: 120,
    outputTokens: 8,
    reasoningTokens: 5,
  },
  replacementItems: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retained user history' }],
      author: 'provider',
      token_count: 7,
      future_provider_field: { nested: ['kept', 7, true, null] },
    },
    {
      type: 'compaction',
      id: 'cmp_fixture',
      encrypted_content: 'opaque-native-state',
    },
  ],
}

describe('Codex Native Checkpoint codec', () => {
  it('round-trips schema v1 and preserves unknown canonical item fields', () => {
    const block = encodeCodexNativeCheckpoint(VALID_CHECKPOINT)

    expect(block.type).toBe(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
    expect(block).toHaveProperty('text', '')
    expect(JSON.parse(block.state)).toEqual(VALID_CHECKPOINT)
    const decoded = decodeCodexNativeCheckpoint(block)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.checkpoint).toEqual(VALID_CHECKPOINT)
  })

  it('rejects a nonempty generic-presentation field on the opaque block', () => {
    const block = encodeCodexNativeCheckpoint(VALID_CHECKPOINT)

    expect(decodeCodexNativeCheckpoint({ ...block, text: 'opaque-native-state' }).ok).toBe(false)
  })

  it('rejects credential-bearing fields outside the exact opaque block envelope', () => {
    const block = encodeCodexNativeCheckpoint(VALID_CHECKPOINT)

    expect(decodeCodexNativeCheckpoint({
      ...block,
      accessToken: 'plain-secret-token',
    }).ok).toBe(false)
  })

  it('rejects deeply nested malformed state without throwing', () => {
    const state = `${'['.repeat(12_000)}null${']'.repeat(12_000)}`

    expect(() => decodeCodexNativeCheckpoint({
      type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      state,
    })).not.toThrow()
    expect(decodeCodexNativeCheckpoint({
      type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      state,
    }).ok).toBe(false)
  })

  it('keeps JWT-shaped opaque provider content without treating it as a credential', () => {
    const checkpoint = {
      ...VALID_CHECKPOINT,
      replacementItems: [
        VALID_CHECKPOINT.replacementItems[0]!,
        {
          ...VALID_CHECKPOINT.replacementItems[1]!,
          encrypted_content: 'opaqueopaque.payloadpayload.artifact',
        },
      ],
    } satisfies CodexNativeCheckpointV1

    const decoded = decodeCodexNativeCheckpoint(encodeCodexNativeCheckpoint(checkpoint))

    expect(decoded).toEqual({ ok: true, checkpoint })
  })

  it('matches the domain-separated compatibility digest worked example', () => {
    const accountHash = hashCodexAccountIdentity('acct_native_fixture')
    expect(accountHash).toBe(
      'sha256:d946e88690451b09a509fb48ac4c8f567feee2d187e326062e366bcd8e78ba54',
    )
    expect(codexNativeCheckpointCompatibilityDigest({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      accountHash,
      instructions: 'SYSTEM FIXTURE',
      tools: null,
      parallelToolCalls: true,
      toolChoice: 'auto',
      reasoning: null,
      text: { verbosity: 'low' },
      serviceTier: null,
    })).toBe('sha256:a4c104af1183869da9e71a262b6864bcafc01dcbc9f22657d3ac18451ae3bf4d')
  })

  it('pins replay to the observed DSH and pi-ai conversion pair', () => {
    expect(CODEX_NATIVE_REPLAY_COMPATIBILITY).toEqual({
      dsh: '0.1.1-rc.2',
      piAi: '0.82.1',
    })
    expect(isCodexNativeReplayRuntimeCompatible({
      dshLlm: '0.1.1-rc.2',
      dshPiAi: '0.1.1-rc.2',
      piAi: '0.82.1',
    })).toBe(true)
    expect(isCodexNativeReplayRuntimeCompatible({
      dshLlm: '0.1.1-rc.2',
      dshPiAi: '0.1.1-rc.3',
      piAi: '0.82.1',
    })).toBe(false)
  })

  it('refuses values JSON.stringify would silently lose', () => {
    const lossy = {
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque',
        silentlyDropped: undefined,
      }],
    } as unknown as CodexNativeCheckpointV1

    expect(() => encodeCodexNativeCheckpoint(lossy)).toThrow(/lossless JSON/u)
  })

  it.each([
    ['unknown schema version', JSON.stringify({ ...VALID_CHECKPOINT, schemaVersion: 2 })],
    ['lossy negative zero', JSON.stringify(VALID_CHECKPOINT).replace(
      '"estimatedTokens":321',
      '"estimatedTokens":-0',
    )],
    ['malformed JSON', '{'],
    ['credential material hidden in retained unknown fields', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [
        {
          type: 'message',
          role: 'user',
          content: 'retained history',
          encrypted_content: 'Bearer secret',
        },
        VALID_CHECKPOINT.replacementItems[1],
      ],
    })],
    ['credential material', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        authorization: 'Bearer secret',
      }],
    })],
    ['plain credential material', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        token: 'plain-secret-token',
      }],
    })],
    ['JWT credential material', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        opaque_blob: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY2NvdW50In0.signature',
      }],
    })],
    ['raw headers', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        headers: { 'x-codex-turn-state': 'secret' },
      }],
    })],
    ['raw cookie header', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        cookie: 'session=secret',
      }],
    })],
    ['raw proxy authorization header', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        proxy_authorization: 'Basic secret',
      }],
    })],
    ['transient compaction trigger', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [
        VALID_CHECKPOINT.replacementItems[0],
        {
          ...VALID_CHECKPOINT.replacementItems[1],
          compaction_trigger: 'must-not-persist',
        },
      ],
    })],
    ['raw turn state', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        turn_state: 'secret',
      }],
    })],
    ['namespaced request id', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        x_request_id: 'provider-routing-id',
      }],
    })],
    ['namespaced raw account id', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        chatgpt_account_id: 'raw-account-id',
      }],
    })],
    ['namespaced auth token', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        x_auth_token: 'plain-secret-token',
      }],
    })],
    ['wrapped refresh token', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        x_refresh_token_value: 'plain-secret-token',
      }],
    })],
    ['namespaced credential object', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        provider_credentials_snapshot: { value: 'plain-secret-token' },
      }],
    })],
    ['discriminated authorization wrapper', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        metadata: { name: 'authorization', value: 'Basic raw-secret' },
      }],
    })],
    ['discriminated access-token wrapper', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        metadata: { type: 'access_token', value: 'plain-token' },
      }],
    })],
    ['authorization tuple wrapper', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        metadata: [['authorization', 'Basic raw-secret']],
      }],
    })],
    ['an empty non-canonical replacement item', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{}],
    })],
    ['an unknown canonical item type', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{ type: 'garbage' }],
    })],
    ['replacement history without a terminal compaction item', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [VALID_CHECKPOINT.replacementItems[0]],
    })],
    ['a compaction item before retained user history', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [...VALID_CHECKPOINT.replacementItems].reverse(),
    })],
    ['retained input text without text bytes', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [
        { role: 'user', content: [{ type: 'input_text' }] },
        VALID_CHECKPOINT.replacementItems[1],
      ],
    })],
    ['an unknown retained content-part type', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [
        { role: 'user', content: [{ type: 'garbage', text: 'not canonical' }] },
        VALID_CHECKPOINT.replacementItems[1],
      ],
    })],
    ['image-bearing retained history', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [
        { role: 'user', content: [{ type: 'input_image', image_url: 'fixture' }] },
        VALID_CHECKPOINT.replacementItems[1],
      ],
    })],
    ['prototype-polluting canonical item keys', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [JSON.parse(
        '{"type":"compaction","encrypted_content":"opaque-native-state","__proto__":{"polluted":true}}',
      ) as Record<string, unknown>],
    })],
    ['request-scoped session metadata', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'opaque-native-state',
        session_id: 'session-must-not-persist',
      }],
    })],
    ['serialized state over 2 MiB', JSON.stringify({
      ...VALID_CHECKPOINT,
      replacementItems: [{
        type: 'compaction',
        encrypted_content: 'x'.repeat(MAX_CODEX_NATIVE_CHECKPOINT_BYTES),
      }],
    })],
  ])('rejects %s', (_label, state) => {
    const decoded = decodeCodexNativeCheckpoint({
      type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      state,
    })

    expect(decoded.ok).toBe(false)
  })
})

const MODEL = 'gpt-5.6-sol'
const ACCOUNT_ID = 'acct_native_fixture'
const ACCOUNT_HASH = 'sha256:d946e88690451b09a509fb48ac4c8f567feee2d187e326062e366bcd8e78ba54'
const COMPATIBILITY_DIGEST = 'sha256:a4c104af1183869da9e71a262b6864bcafc01dcbc9f22657d3ac18451ae3bf4d'
const GENERATED_MARKER = '[[dsh-codex-native-checkpoint:00000000-0000-4000-8000-000000000000]]'
const SYSTEM = 'SYSTEM FIXTURE'
const BASIC_CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const PORTABLE_TEXT = `${BASIC_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>PORTABLE CHECKPOINT</compacted-summary>`

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

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) {
    const encoding = new Headers(init?.headers).get('content-encoding')
    const bytes = encoding === 'zstd' ? zstdDecompressSync(body) : body
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  }
  throw new Error(`unexpected request body: ${Object.prototype.toString.call(body)}`)
}

function createCodexAdapter(
  ctx: Context,
  fetchImpl: typeof fetch,
  onPayload?: CodexAuthAdapterOptions['onPayload'],
): CodexAuthAdapter {
  return new CodexAuthAdapter(ctx, {
    auth: {
      credential: () => Promise.resolve({
        accessToken: fakeAccessToken(ACCOUNT_ID),
        accountId: ACCOUNT_ID,
      }),
    },
    authJsonPath: '/nonexistent/auth.json',
    credentialRef: credentialRef('CODEX_CHATGPT_TOKEN'),
    refreshLeadMs: 5 * 60 * 1000,
    fetchImpl,
    displayName: 'OpenAI Codex (chatgpt)',
    settings: () => ({ longContextEnabled: false }),
    transport: 'sse',
    websocketConnectTimeoutMs: 1_000,
    timeoutMs: 5_000,
    ...onPayload === undefined ? {} : { onPayload },
  })
}

function mountCodexAdapter(
  payloads: unknown[],
  onPayload?: CodexAuthAdapterOptions['onPayload'],
): { ctx: Context; adapter: CodexAuthAdapter; release: () => void; fetchMock: typeof fetch } {
  context = new Context()
  void new LlmRuntime(context)
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    payloads.push(requestBodyJson(init))
    return new Response('fixture stop', { status: 400 })
  }) as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  const adapter = createCodexAdapter(context, fetchMock, onPayload)
  const release = context.llm.registerAdapter(['openai-codex'], adapter)
  return { ctx: context, adapter, release, fetchMock }
}

function registerDeepSeekAdapter(ctx: Context): { readonly provider: string; readonly model: string } {
  const provider = 'deepseek-official'
  const model = 'deepseek-chat'
  const connection = resolveAdapterOptions({
    baseURL: 'https://deepseek.invalid/v1',
    models: [{ id: model }],
  })
  ctx.llm.registerAdapter([provider], new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve('deepseek-test-key'),
    resolveUserId: () => 'anonymous-test-user' as never,
  }))
  return { provider, model }
}

function registerPiAiAdapter(ctx: Context): { readonly provider: string; readonly model: string } {
  const piProvider = builtinProviders().find(candidate => candidate.id === 'openai')
  if (piProvider === undefined) throw new Error('pi-ai fixture has no openai provider')
  const model = piProvider.getModels()[0]?.id
  if (model === undefined) throw new Error('pi-ai openai fixture has no model')
  const profile: ResolvedPiAiProviderProfile = {
    provider: piProvider.id,
    displayName: 'Foreign pi-ai fixture',
    streamIdleTimeoutMs: 5_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 640_000,
    requestImageMaxBytes: 20 * 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'foreign pi-ai fixture'),
    piProvider,
    configuredMaxTokens: new Map(),
  }
  ctx.llm.registerAdapter([profile.provider], new PiAiAdapter({
    profiles: () => new Map([[profile.provider, profile]]),
    resolveApiKey: () => Promise.resolve('openai-test-key'),
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
  }))
  return { provider: profile.provider, model }
}

function compatibleCheckpoint(): CodexNativeCheckpointV1 {
  return {
    ...VALID_CHECKPOINT,
    provenance: {
      provider: 'openai-codex',
      model: MODEL,
      accountHash: ACCOUNT_HASH,
    },
    compatibilityDigest: COMPATIBILITY_DIGEST,
  }
}

function checkpointMessage(
  checkpoint: CodexNativeCheckpointV1,
  portableSummary = 'PORTABLE CHECKPOINT',
  compactionId = 'cmp_existing',
) {
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `${BASIC_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>`,
      },
      { type: 'text', text: portableSummary },
      encodeCodexNativeCheckpoint(checkpoint),
      { type: 'text', text: '</compacted-summary>' },
    ],
    source: compactCheckpointSource(CompactionId(compactionId)),
  })
}

function replayOptions(checkpoint = compatibleCheckpoint()): GenerateOptions {
  return deepFreeze({
    provider: 'openai-codex',
    model: MODEL,
    system: SYSTEM,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: 'before checkpoint' }],
        source: { kind: 'user' },
      }),
      checkpointMessage(checkpoint),
      createUserMessage({
        content: [{ type: 'text', text: 'tail after checkpoint' }],
        source: { kind: 'user' },
      }),
    ],
  })
}

function replayOptionsWithRawCheckpointState(
  state: string | ((checkpoint: Record<string, unknown>) => void),
): GenerateOptions {
  const options = replayOptions()
  const checkpoint = options.messages[1]!
  const content = checkpoint.content.map((block) => {
    if (block.type !== CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE) return block
    if (typeof state === 'string') return { ...block, state }
    const parsed = JSON.parse(block.state) as Record<string, unknown>
    state(parsed)
    return { ...block, state: JSON.stringify(parsed) }
  })
  return deepFreeze({
    ...options,
    messages: [
      options.messages[0]!,
      { ...checkpoint, content },
      options.messages[2]!,
    ],
  }) as GenerateOptions
}

function portableUserPayloadItem(): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'input_text', text: PORTABLE_TEXT }],
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Payload capture happens before the scripted HTTP failure settles.
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Codex Native Checkpoint replay', () => {
  it('restores one checkpoint through ctx.llm.stream at the same payload position', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const options = replayOptions()
    const originalMessages = options.messages

    await drain(ctx.llm.stream(options))

    expect(options.messages).toBe(originalMessages)
    expect(payloads).toHaveLength(1)
    const payload = payloads[0] as { input?: unknown[] }
    expect(payload.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'before checkpoint' }],
      },
      ...compatibleCheckpoint().replacementItems,
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'tail after checkpoint' }],
      },
    ])
    expect(JSON.stringify(payload)).not.toContain(PORTABLE_TEXT)
    expect(JSON.stringify(payload)).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
  })

  it('replays through the Adapter direct stream path without mutating frozen options', async () => {
    const payloads: unknown[] = []
    const { adapter } = mountCodexAdapter(payloads)
    const options = replayOptions()

    await drain(adapter.stream(options))

    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(PORTABLE_TEXT)
  })

  it.each([
    ['shipped direct DeepSeek Adapter', registerDeepSeekAdapter],
    ['shipped PiAiAdapter', registerPiAiAdapter],
  ] as const)('sends Portable through the %s and keeps Native for a Codex round trip', async (
    _label,
    registerForeign,
  ) => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const route = registerForeign(ctx)
    const codex = replayOptions()

    await drain(ctx.llm.stream(deepFreeze({
      ...codex,
      provider: route.provider,
      model: route.model,
    })))
    await drain(ctx.llm.stream(codex))

    expect(payloads).toHaveLength(2)
    expect(JSON.stringify(payloads[0])).toContain('PORTABLE CHECKPOINT')
    expect(JSON.stringify(payloads[0])).not.toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
    expect(JSON.stringify(payloads[1])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[1])).not.toContain(PORTABLE_TEXT)
  })

  it('splices multiple native checkpoints in order while preserving intervening and tail items', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const first = compatibleCheckpoint()
    const second = {
      ...compatibleCheckpoint(),
      replacementItems: [{
        type: 'compaction',
        id: 'cmp_second',
        encrypted_content: 'second-native-state',
      }],
    } satisfies CodexNativeCheckpointV1
    const base = replayOptions(first)
    const between = createUserMessage({
      content: [{ type: 'text', text: 'between checkpoints' }],
      source: { kind: 'user' },
    })
    const options = deepFreeze({
      ...base,
      messages: [
        base.messages[0]!,
        base.messages[1]!,
        between,
        checkpointMessage(second, 'SECOND PORTABLE', 'cmp_second'),
        base.messages[2]!,
      ],
    })

    await drain(ctx.llm.stream(options))

    const payload = payloads[0] as { input?: unknown[] }
    expect(payload.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'before checkpoint' }],
      },
      ...first.replacementItems,
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'between checkpoints' }],
      },
      ...second.replacementItems,
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'tail after checkpoint' }],
      },
    ])
    expect(JSON.stringify(payload)).not.toContain('SECOND PORTABLE')
  })

  it('degrades malformed mixtures, duplicate native blocks, and corrupt state to text-only Portable', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const nativeBlock = encodeCodexNativeCheckpoint(compatibleCheckpoint())
    const open = `${BASIC_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>`
    const close = '</compacted-summary>'
    const frame = (
      middle: readonly unknown[],
      id: string,
      firstText = open,
      lastText = close,
    ): GenerateOptions => deepFreeze({
      provider: 'openai-codex',
      model: MODEL,
      system: SYSTEM,
      messages: [
        createUserMessage({
          content: [
            { type: 'text', text: firstText },
            { type: 'text', text: 'PORTABLE CHECKPOINT' },
            ...middle,
            { type: 'text', text: lastText },
          ] as Parameters<typeof createUserMessage>[0]['content'],
          source: compactCheckpointSource(CompactionId(id)),
        }),
      ],
    })
    const cases = [
      {
        options: frame([{ type: 'reasoning', text: 'unexpected mixture' }, nativeBlock], 'cmp_mixture'),
        portableText: PORTABLE_TEXT,
      },
      { options: frame([nativeBlock, nativeBlock], 'cmp_duplicate'), portableText: PORTABLE_TEXT },
      {
        options: frame([{ type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE, state: '{' }], 'cmp_corrupt'),
        portableText: PORTABLE_TEXT,
      },
      {
        options: frame([nativeBlock], 'cmp_bad_open', 'corrupted opening frame'),
        portableText: `corrupted opening framePORTABLE CHECKPOINT${close}`,
      },
      {
        options: frame([nativeBlock], 'cmp_bad_close', open, 'corrupted closing frame'),
        portableText: `${open}PORTABLE CHECKPOINTcorrupted closing frame`,
      },
    ]

    for (const { options } of cases) await drain(ctx.llm.stream(options))

    expect(payloads).toHaveLength(cases.length)
    for (const [index, payload] of (payloads as Array<{ input?: unknown[] }>).entries()) {
      expect(payload.input).toEqual([{
        role: 'user',
        content: [{ type: 'input_text', text: cases[index]!.portableText }],
      }])
      expect(JSON.stringify(payload)).not.toContain('opaque-native-state')
      expect(JSON.stringify(payload)).not.toContain('unexpected mixture')
    }
  })

  it.each([
    ['corrupt JSON', () => replayOptionsWithRawCheckpointState('{')],
    ['unknown schema version', () => replayOptionsWithRawCheckpointState((checkpoint) => {
      checkpoint.schemaVersion = 2
    })],
    ['unknown codec generation', () => replayOptionsWithRawCheckpointState((checkpoint) => {
      const codec = checkpoint.codec as Record<string, unknown>
      codec.generation = 2
    })],
    ['unknown retention generation', () => replayOptionsWithRawCheckpointState((checkpoint) => {
      const retention = checkpoint.retention as Record<string, unknown>
      retention.generation = 2
    })],
  ] as const)('uses Portable fallback for %s', async (_label, options) => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)

    await drain(ctx.llm.stream(options()))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('PORTABLE CHECKPOINT')
    expect(JSON.stringify(payloads[0])).not.toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
  })

  it('preserves ordinary marker-like text that was not generated for the request', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const base = replayOptions()
    const markerLike = '[[dsh-codex-native-checkpoint:ordinary-user-text]]'
    const options = deepFreeze({
      ...base,
      messages: [
        ...base.messages,
        createUserMessage({
          content: [{ type: 'text', text: markerLike }],
          source: { kind: 'user' },
        }),
      ],
    })

    await drain(ctx.llm.stream(options))

    expect(JSON.stringify(payloads[0])).toContain(markerLike)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
  })

  it.each([
    ['model provenance', {
      ...compatibleCheckpoint(),
      provenance: { ...compatibleCheckpoint().provenance, model: 'gpt-other' },
    }],
    ['compatibility digest', {
      ...compatibleCheckpoint(),
      compatibilityDigest: `sha256:${'d'.repeat(64)}`,
    }],
  ] satisfies ReadonlyArray<readonly [string, CodexNativeCheckpointV1]>)(
    'uses Portable fallback when %s differs',
    async (_label, checkpoint) => {
      const payloads: unknown[] = []
      const { ctx } = mountCodexAdapter(payloads)

      await drain(ctx.llm.stream(replayOptions(checkpoint)))

      const payload = payloads[0] as { input?: unknown[] }
      expect(payload.input?.[1]).toEqual({
        role: 'user',
        content: [{ type: 'input_text', text: PORTABLE_TEXT }],
      })
      expect(JSON.stringify(payload)).not.toContain('opaque-native-state')
    },
  )

  it('uses one ordinary Portable user item when account compatibility fails', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const incompatible = {
      ...compatibleCheckpoint(),
      provenance: {
        ...compatibleCheckpoint().provenance,
        accountHash: `sha256:${'c'.repeat(64)}`,
      },
    } satisfies CodexNativeCheckpointV1

    await drain(ctx.llm.stream(replayOptions(incompatible)))

    const payload = payloads[0] as { input?: unknown[] }
    expect(payload.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'before checkpoint' }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: PORTABLE_TEXT }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'tail after checkpoint' }],
      },
    ])
    expect(JSON.stringify(payload)).not.toContain('opaque-native-state')
  })

  it('restores native items before awaiting the prior payload callback', async () => {
    const payloads: unknown[] = []
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    let callbackPayload: unknown
    const callback = vi.fn(async (payload: unknown) => {
      callbackPayload = structuredClone(payload)
      await gate
      return { ...(payload as Record<string, unknown>), priorCallback: 'complete' }
    })
    const { ctx } = mountCodexAdapter(payloads, callback)

    const pending = drain(ctx.llm.stream(replayOptions()))
    await vi.waitFor(() => { expect(callback).toHaveBeenCalledOnce() })

    expect(payloads).toHaveLength(0)
    expect(JSON.stringify(callbackPayload)).toContain('opaque-native-state')
    expect(JSON.stringify(callbackPayload)).not.toContain(PORTABLE_TEXT)
    expect(JSON.stringify(callbackPayload)).not.toContain('[[dsh-codex-native-checkpoint:')
    resume()
    await pending
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual(expect.objectContaining({ priorCallback: 'complete' }))
  })

  it('isolates concurrent request plans even when their marker entropy collides', async () => {
    const payloads: unknown[] = []
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const callback = async () => {
      arrived += 1
      if (arrived === 2) release()
      await gate
      return undefined
    }
    const { ctx } = mountCodexAdapter(payloads, callback)
    const first = {
      ...compatibleCheckpoint(),
      replacementItems: [{ type: 'compaction', id: 'first', encrypted_content: 'native-first' }],
    } satisfies CodexNativeCheckpointV1
    const second = {
      ...compatibleCheckpoint(),
      replacementItems: [{ type: 'compaction', id: 'second', encrypted_content: 'native-second' }],
    } satisfies CodexNativeCheckpointV1

    await Promise.all([
      drain(ctx.llm.stream(replayOptions(first))),
      drain(ctx.llm.stream(replayOptions(second))),
    ])

    expect(payloads).toHaveLength(2)
    const serialized = payloads.map(payload => JSON.stringify(payload))
    expect(serialized.filter(payload => payload.includes('native-first'))).toHaveLength(1)
    expect(serialized.filter(payload => payload.includes('native-second'))).toHaveLength(1)
    expect(serialized.every(payload => !payload.includes(PORTABLE_TEXT))).toBe(true)
  })

  it('keeps the restored payload when the prior callback returns undefined', async () => {
    const payloads: unknown[] = []
    const callback = vi.fn(() => undefined)
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions()))

    expect(callback).toHaveBeenCalledOnce()
    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(PORTABLE_TEXT)
  })

  it('restores Native when the final callback makes initially incompatible controls exact', async () => {
    const payloads: unknown[] = []
    const checkpoint = {
      ...compatibleCheckpoint(),
      compatibilityDigest: codexNativeCheckpointCompatibilityDigest({
        provider: 'openai-codex',
        model: MODEL,
        accountHash: ACCOUNT_HASH,
        instructions: SYSTEM,
        tools: null,
        parallelToolCalls: true,
        toolChoice: 'auto',
        reasoning: null,
        text: { verbosity: 'high' },
        serviceTier: null,
      }),
    } satisfies CodexNativeCheckpointV1
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown>
      body.text = { verbosity: 'high' }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions(checkpoint)))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(PORTABLE_TEXT)
  })

  it('restores Native when the final callback corrects the routed model', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown>
      body.model = MODEL
    }
    const { ctx } = mountCodexAdapter(payloads, callback)
    const options = {
      ...replayOptions(),
      model: 'gpt-5.6-luna',
    }

    await drain(ctx.llm.stream(options))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(PORTABLE_TEXT)
  })

  it('keeps Native when final callbacks add excluded request-scoped routing facts', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      request_id: 'req_transient',
      prompt_cache_key: 'cache_transient',
      transient_headers: { 'x-request-id': 'header_transient' },
      turn_state: 'turn_transient',
      long_context_mode: true,
    })
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(PORTABLE_TEXT)
  })

  it.each([
    ['model', (body: Record<string, unknown>) => { body.model = 'gpt-different' }],
    ['instructions', (body: Record<string, unknown>) => { body.instructions = 'changed system' }],
    ['tools', (body: Record<string, unknown>) => { body.tools = [{ type: 'function', name: 'changed' }] }],
    ['parallel tool calls', (body: Record<string, unknown>) => { body.parallel_tool_calls = false }],
    ['tool choice', (body: Record<string, unknown>) => { body.tool_choice = 'required' }],
    ['reasoning', (body: Record<string, unknown>) => { body.reasoning = { effort: 'high' } }],
    ['text configuration', (body: Record<string, unknown>) => { body.text = { verbosity: 'high' } }],
    ['service tier', (body: Record<string, unknown>) => { body.service_tier = 'flex' }],
  ])('substitutes Portable before fetch when the final callback changes %s', async (_field, change) => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      change(payload as Record<string, unknown>)
      return undefined
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('PORTABLE CHECKPOINT')
    expect(JSON.stringify(payloads[0])).not.toContain('opaque-native-state')
    expect(JSON.stringify(payloads[0])).not.toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
  })

  it('rejects multipart Portable text reintroduced beside Native items', async () => {
    const payloads: unknown[] = []
    const split = Math.floor(PORTABLE_TEXT.length / 2)
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [
          ...body.input,
          {
            role: 'user',
            content: [
              { type: 'input_text', text: PORTABLE_TEXT.slice(0, split) },
              { type: 'input_text', text: PORTABLE_TEXT.slice(split) },
            ],
          },
        ],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('rejects string-form Portable text reintroduced beside Native items', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [...body.input, { role: 'user', content: PORTABLE_TEXT }],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('preserves an ordinary user quotation that merely contains Portable text', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [...body.input, {
          role: 'user',
          content: [{ type: 'input_text', text: `quoted checkpoint:\n${PORTABLE_TEXT}` }],
        }],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('quoted checkpoint')
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
  })

  it('preserves mixed user content that includes Portable text beside an image', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [...body.input, {
          role: 'user',
          content: [
            { type: 'input_text', text: PORTABLE_TEXT },
            { type: 'input_image', image_url: 'data:image/png;base64,fixture' },
          ],
        }],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    await drain(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain('input_image')
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
  })

  it('rejects a duplicate Native artifact added beside Native replay', async () => {
    const payloads: unknown[] = []
    const nativeArtifact = compatibleCheckpoint().replacementItems.at(-1)
    if (nativeArtifact === undefined) throw new Error('fixture has no Native artifact')
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [...body.input, structuredClone(nativeArtifact)],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('rejects a duplicate Portable representation added beside Portable fallback', async () => {
    const payloads: unknown[] = []
    const checkpoint = {
      ...compatibleCheckpoint(),
      compatibilityDigest: `sha256:${'c'.repeat(64)}`,
    } satisfies CodexNativeCheckpointV1
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [...body.input, portableUserPayloadItem()],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions(checkpoint)))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('rejects forward-extended Native items reintroduced beside Portable fallback', async () => {
    const payloads: unknown[] = []
    const checkpoint = {
      ...compatibleCheckpoint(),
      compatibilityDigest: `sha256:${'d'.repeat(64)}`,
    } satisfies CodexNativeCheckpointV1
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [
          ...body.input,
          {
            ...checkpoint.replacementItems.at(-1),
            callback_metadata: true,
          },
        ],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions(checkpoint)))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it.each([
    ['Native', compatibleCheckpoint()],
    ['Portable', {
      ...compatibleCheckpoint(),
      compatibilityDigest: `sha256:${'e'.repeat(64)}`,
    } satisfies CodexNativeCheckpointV1],
  ])('rejects a callback that erases the %s checkpoint representation', async (_label, checkpoint) => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      input: [],
    })
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions(checkpoint)))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('downgrades an in-flight replay plan when its Adapter generation changes', async () => {
    const payloads: unknown[] = []
    let callbackArrived!: () => void
    let releaseCallback!: () => void
    const arrived = new Promise<void>(resolve => { callbackArrived = resolve })
    const gate = new Promise<void>(resolve => { releaseCallback = resolve })
    const callback = async () => {
      callbackArrived()
      await gate
      return undefined
    }
    const { ctx, adapter } = mountCodexAdapter(payloads, callback)
    const options = replayOptions()
    const running = drain(ctx.llm.stream(options))
    await arrived

    adapter.replaceRouteGeneration()
    releaseCallback()
    await running
    await drain(ctx.llm.stream(options))

    expect(payloads).toHaveLength(2)
    expect(JSON.stringify(payloads[0])).toContain('PORTABLE CHECKPOINT')
    expect(JSON.stringify(payloads[0])).not.toContain('opaque-native-state')
    expect(JSON.stringify(payloads[1])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[1])).not.toContain(PORTABLE_TEXT)
    expect(JSON.stringify(options)).toContain(CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)
  })

  it('invalidates stale prepared replay state while a replacement keeps the durable Native checkpoint', async () => {
    const payloads: unknown[] = []
    const generation = (name: string): NonNullable<CodexAuthAdapterOptions['onPayload']> => (
      payload => ({ ...(payload as Record<string, unknown>), adapterGeneration: name })
    )
    const { ctx, adapter, release, fetchMock } = mountCodexAdapter(payloads, generation('prepared'))
    const prepared = await ctx.llm.prepareCall({ provider: 'openai-codex', model: MODEL })
    adapter.replaceRouteGeneration()
    release()
    const replacement = createCodexAdapter(ctx, fetchMock, generation('direct'))
    ctx.llm.registerAdapter(['openai-codex'], replacement)

    await drain(prepared.stream(deepFreeze({
      ...replayOptions(),
      ...prepared.config,
    })))
    await drain(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toEqual(expect.objectContaining({ adapterGeneration: 'prepared' }))
    expect(JSON.stringify(payloads[0])).toContain('PORTABLE CHECKPOINT')
    expect(JSON.stringify(payloads[0])).not.toContain('opaque-native-state')
    expect(payloads[1]).toEqual(expect.objectContaining({ adapterGeneration: 'direct' }))
    expect(JSON.stringify(payloads[1])).toContain('opaque-native-state')
    expect(JSON.stringify(payloads[1])).not.toContain(PORTABLE_TEXT)
  })

  it.each([
    ['duplicate', GENERATED_MARKER],
    ['embedded', `prefix ${GENERATED_MARKER} suffix`],
  ])('rejects a %s generated marker introduced by a callback', async (_label, text) => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown> & { input: unknown[] }
      return {
        ...body,
        input: [
          ...body.input,
          { role: 'user', content: [{ type: 'input_text', text }] },
        ],
      }
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('chooses a different marker when ordinary user text collides with generated entropy', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const base = replayOptions()
    const options = deepFreeze({
      ...base,
      messages: [
        ...base.messages,
        createUserMessage({
          content: [{ type: 'text', text: GENERATED_MARKER }],
          source: { kind: 'user' },
        }),
      ],
    })

    await drain(ctx.llm.stream(options))

    expect(payloads).toHaveLength(1)
    expect(JSON.stringify(payloads[0])).toContain(GENERATED_MARKER)
    expect(JSON.stringify(payloads[0])).toContain('opaque-native-state')
  })

  it('rejects a generated marker leaked by canonical native items before fetch', async () => {
    const payloads: unknown[] = []
    const { ctx } = mountCodexAdapter(payloads)
    const checkpoint = {
      ...compatibleCheckpoint(),
      replacementItems: [{
        type: 'compaction',
        encrypted_content: GENERATED_MARKER,
      }],
    } satisfies CodexNativeCheckpointV1

    const chunks = await collect(ctx.llm.stream(replayOptions(checkpoint)))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('rejects nested non-JSON callback state that conceals a generated marker', async () => {
    const payloads: unknown[] = []
    class ExoticLeak {
      readonly text = GENERATED_MARKER
    }
    const callback = (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      nested: new ExoticLeak(),
    })
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })

  it('rejects a non-plain final payload before fetch', async () => {
    const payloads: unknown[] = []
    class ExoticPayload {}
    const callback = (payload: unknown) => Object.assign(
      new ExoticPayload(),
      payload as Record<string, unknown>,
    )
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
  })
})
