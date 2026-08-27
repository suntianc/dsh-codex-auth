import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
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
    expect(JSON.parse(block.state)).toEqual(VALID_CHECKPOINT)
    const decoded = decodeCodexNativeCheckpoint(block)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.checkpoint).toEqual(VALID_CHECKPOINT)
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

  it('fails before fetch when the prior callback changes native compatibility controls', async () => {
    const payloads: unknown[] = []
    const callback = (payload: unknown) => {
      const body = payload as Record<string, unknown>
      body.text = { verbosity: 'high' }
      return undefined
    }
    const { ctx } = mountCodexAdapter(payloads, callback)

    const chunks = await collect(ctx.llm.stream(replayOptions()))

    expect(payloads).toHaveLength(0)
    expect(chunks.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      reason: expect.objectContaining({ kind: 'error' }),
    }))
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
              { type: 'input_image', image_url: 'data:image/png;base64,fixture' },
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

  it('keeps the ctx.llm.prepareCall Adapter generation while ctx.llm.stream uses its replacement', async () => {
    const payloads: unknown[] = []
    const generation = (name: string): NonNullable<CodexAuthAdapterOptions['onPayload']> => (
      payload => ({ ...(payload as Record<string, unknown>), adapterGeneration: name })
    )
    const { ctx, release, fetchMock } = mountCodexAdapter(payloads, generation('prepared'))
    const prepared = await ctx.llm.prepareCall({ provider: 'openai-codex', model: MODEL })
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
    expect(payloads[1]).toEqual(expect.objectContaining({ adapterGeneration: 'direct' }))
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).toContain('opaque-native-state')
      expect(JSON.stringify(payload)).not.toContain(PORTABLE_TEXT)
    }
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
