/** Public ToolRuntime seam regressions for Codex Image Creation and Image Catalog. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_IMAGE_EDIT_ENDPOINT, CODEX_IMAGE_GENERATION_ENDPOINT, createCodexImageTools,
  type CodexImageSettings, type CodexImageToolOptions,
} from '../src/image.ts'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7xkAAAAASUVORK5CYII='
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))

const SETTINGS: CodexImageSettings = {
  enabled: true,
  model: 'gpt-image-2',
  n: 1,
  size: 'auto',
  quality: 'auto',
  background: 'auto',
}

function attachmentRef(id: string, name = `${id}.png`): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: PNG_BYTES.byteLength,
    width: 1,
    height: 1,
    name,
  }
}

function fakeAgent(events: unknown[] = [], overrides: Partial<Agent['options']> = {}): Agent {
  const ctx = new Context()
  return {
    id: SessionId('session-1'),
    options: { provider: 'openai-codex', model: 'gpt-5.4', ...overrides },
    session: {
      id: SessionId('session-1'),
      header: { version: 0, id: SessionId('session-1'), createdAt: 1, cwd: '/workspace' },
      events,
      requestHeader: () => undefined,
    },
    ctx,
  } as unknown as Agent
}

function bench(overrides: Partial<CodexImageToolOptions> = {}) {
  const saved: SaveImageAttachment[] = []
  const refs = new Map<string, { ref: ImageAttachmentRef; data: Uint8Array }>()
  let nextId = 1
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 10,
      maxMessageImageBytes: 10 * 1024 * 1024,
      maxImagePixels: 10_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
    },
    validateImage: vi.fn(async (_input: SaveImageAttachment) => {}),
    saveImage: vi.fn(async (input: SaveImageAttachment) => {
      saved.push(input)
      const ref = attachmentRef(`att-${nextId++}`, input.name)
      refs.set(String(ref.attachmentId), { ref, data: input.data })
      return ref
    }),
    readImage: vi.fn(async (ref: ImageAttachmentRef) => refs.get(String(ref.attachmentId)) ?? { ref, data: PNG_BYTES }),
  }
  const fs = {
    resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => ({ path: path.startsWith('/') ? path : `${opts?.cwd}/${path}` })),
    contains: vi.fn((parent: { path: string }, child: { path: string }) => child.path === parent.path || child.path.startsWith(`${parent.path}/`)),
    processPath: vi.fn((target: { path: string }) => target.path),
    readBytes: vi.fn(async () => PNG_BYTES),
  }
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    created: 1_778_832_973,
    data: [{ b64_json: PNG_BASE64 }],
    background: 'auto',
    quality: 'auto',
    size: '1024x1024',
  }), { status: 200 }))
  const options: CodexImageToolOptions = {
    auth: { credential: vi.fn(async () => ({ accessToken: 'access-secret', accountId: 'acct-1', planType: 'plus' })) },
    settings: () => SETTINGS,
    attachments: attachments as CodexImageToolOptions['attachments'],
    fs: fs as unknown as CodexImageToolOptions['fs'],
    resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text', 'image'] as const })),
    fetchImpl,
    ...overrides,
  }
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const tools = new ToolRuntime(ctx)
  for (const tool of createCodexImageTools(options)) tools.register(tool)
  return { attachments, fetchImpl, fs, options, refs, saved, tools }
}

async function execute(
  tools: ToolRuntime,
  name: 'generate_image' | 'list_images',
  arguments_: unknown,
  agent = fakeAgent(),
  signal = new AbortController().signal,
) {
  return tools.execute({
    callId: CallId(`call-${name}`),
    name,
    arguments: arguments_,
    agent,
    signal,
  })
}

describe('generate_image', () => {
  it('dispatches one generation, persists it, and renders a durable ImageBlock', async () => {
    const b = bench()

    const result = await execute(b.tools, 'generate_image', { prompt: 'a red fox' })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(b.fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = b.fetchImpl.mock.calls[0] ?? []
    expect(String(input)).toBe(CODEX_IMAGE_GENERATION_ENDPOINT)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-secret')
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('acct-1')
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: 'a red fox',
      background: 'auto',
      model: 'gpt-image-2',
      n: 1,
      quality: 'auto',
      size: 'auto',
    })
    expect(b.attachments.validateImage).toHaveBeenCalledTimes(1)
    expect(b.attachments.saveImage).toHaveBeenCalledTimes(1)
    expect(result.value).toMatchObject({
      operation: 'generate',
      images: [{ handle: 'image:att-1', attachment: { attachmentId: 'att-1' } }],
      warnings: [],
    })
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('image:att-1') }),
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'att-1' }) },
    ]))
    expect(result.meta).toEqual(result.value)
  })

  it('promotes explicit workspace references and dispatches the edit endpoint', async () => {
    const b = bench()

    const result = await execute(b.tools, 'generate_image', {
      prompt: 'make it nocturnal',
      references: [{ kind: 'workspace', path: 'assets/reference.png' }],
      n: 2,
      quality: 'high',
    })

    expect(result.isError).toBe(false)
    const [input, init] = b.fetchImpl.mock.calls[0] ?? []
    expect(String(input)).toBe(CODEX_IMAGE_EDIT_ENDPOINT)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
      prompt: 'make it nocturnal',
      model: 'gpt-image-2',
      n: 2,
      quality: 'high',
    })
    expect(b.fs.readBytes).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), 1024 * 1024)
    expect(b.attachments.saveImage).toHaveBeenCalledTimes(2)
    if (!result.isError) {
      expect(result.value).toMatchObject({
        operation: 'edit',
        references: [{ handle: 'image:att-1', origin: 'reference' }],
        images: [{ handle: 'image:att-2', origin: 'generated' }],
      })
    }
  })

  it('accepts only session-authorized handles before dispatch', async () => {
    const authorized = attachmentRef('session-image')
    const events = [{
      seq: 1,
      time: 10,
      type: 'user/message',
      data: { content: [{ type: 'image', attachment: authorized }] },
    }]
    const b = bench()

    const ok = await execute(b.tools, 'generate_image', {
      prompt: 'vary this',
      references: [{ kind: 'session', handle: 'image:session-image' }],
    }, fakeAgent(events))
    expect(ok.isError).toBe(false)
    expect(b.attachments.readImage).toHaveBeenCalledWith(authorized, expect.any(AbortSignal))

    const denied = await execute(b.tools, 'generate_image', {
      prompt: 'steal this',
      references: [{ kind: 'session', handle: 'image:other-session' }],
    }, fakeAgent(events))
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'IMAGE_REFERENCE_NOT_AUTHORIZED' } } })
    expect(b.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retains valid images with warnings and fails only when none remain', async () => {
    const partialFetch = vi.fn(async () => new Response(JSON.stringify({
      created: 123,
      data: [{}, { b64_json: 'bm90LWFuLWltYWdl' }, { b64_json: PNG_BASE64 }],
    })))
    const partial = bench({ fetchImpl: partialFetch })
    const result = await execute(partial.tools, 'generate_image', { prompt: 'three' })
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toMatchObject({
        images: [{ handle: 'image:att-1' }],
        warnings: [
          { index: 0, code: 'IMAGE_DATA_MISSING' },
          { index: 1, code: 'IMAGE_MEDIA_INVALID' },
        ],
      })
    }

    const sparse = bench({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        created: 123,
        data: [{ b64_json: PNG_BASE64 }],
      }))),
    })
    const sparseResult = await execute(sparse.tools, 'generate_image', { prompt: 'three', n: 3 })
    expect(sparseResult.isError).toBe(false)
    if (!sparseResult.isError) {
      expect(sparseResult.value).toMatchObject({
        images: [{ handle: 'image:att-1' }],
        warnings: [
          { index: 1, code: 'IMAGE_DATA_MISSING' },
          { index: 2, code: 'IMAGE_DATA_MISSING' },
        ],
      })
    }

    const bounded = bench({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        created: 123,
        data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
      }))),
    })
    bounded.attachments.imageLimits.maxImagesPerMessage = 1
    const boundedResult = await execute(bounded.tools, 'generate_image', { prompt: 'bounded' })
    expect(boundedResult.isError).toBe(false)
    if (!boundedResult.isError) {
      expect(boundedResult.value).toMatchObject({
        images: [{ handle: 'image:att-1' }],
        warnings: [{ index: 1, code: 'IMAGE_POLICY_REJECTED' }],
      })
    }

    const invalid = bench({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ created: 123, data: [{ b64_json: 'bm90LWFuLWltYWdl' }] }))),
    })
    const failed = await execute(invalid.tools, 'generate_image', { prompt: 'invalid' })
    expect(failed).toMatchObject({ isError: true, error: { info: { code: 'IMAGE_RESPONSE_EMPTY' } } })
    expect(invalid.attachments.saveImage).not.toHaveBeenCalled()
  })

  it('rejects locally knowable invalid arguments before dispatch and settles cancellation honestly', async () => {
    const invalid = bench()
    expect(await execute(invalid.tools, 'generate_image', { prompt: 'too many', n: 11 })).toMatchObject({
      isError: true,
      error: { info: { code: 'INVALID_ARGS' } },
    })
    expect(await execute(invalid.tools, 'generate_image', {
      prompt: 'remote reference',
      references: [{ kind: 'workspace', path: 'https://example.com/image.png' }],
    })).toMatchObject({
      isError: true,
      error: { info: { code: 'IMAGE_REFERENCE_INVALID' } },
    })
    expect(invalid.fetchImpl).not.toHaveBeenCalled()

    const controller = new AbortController()
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    }))
    const cancelled = bench({ fetchImpl })
    const pending = execute(cancelled.tools, 'generate_image', { prompt: 'cancel me' }, fakeAgent(), controller.signal)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'IMAGE_CANCELLED' } } })
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('server-side cancellation is not guaranteed') }),
    ]))
  })

  it('does not retry dispatched image requests and rejects known unavailable routes locally', async () => {
    const failedFetch = vi.fn(async () => new Response('temporary', { status: 500 }))
    const upstream = bench({ fetchImpl: failedFetch })
    expect(await execute(upstream.tools, 'generate_image', { prompt: 'once' })).toMatchObject({
      isError: true,
      error: { info: { code: 'IMAGE_UPSTREAM' } },
    })
    expect(failedFetch).toHaveBeenCalledTimes(1)

    const free = bench({ auth: { credential: vi.fn(async () => ({ accessToken: 'token', planType: 'free' })) } })
    expect(await execute(free.tools, 'generate_image', { prompt: 'free' })).toMatchObject({
      isError: true,
      error: { info: { code: 'IMAGE_PLAN_UNAVAILABLE' } },
    })
    expect(free.fetchImpl).not.toHaveBeenCalled()

    const textOnly = bench({ resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] as const })) })
    expect(await execute(textOnly.tools, 'generate_image', { prompt: 'text only' })).toMatchObject({
      isError: true,
      error: { info: { code: 'IMAGE_MODEL_UNAVAILABLE' } },
    })
    expect(textOnly.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('list_images', () => {
  it('pages durable session images newest-first and returns actual ImageBlocks', async () => {
    const generated = attachmentRef('generated', 'generated.png')
    const user = attachmentRef('user', 'uploaded.png')
    const events = [
      { seq: 1, time: 10, type: 'user/message', data: { content: [{ type: 'image', attachment: user }] } },
      { seq: 2, time: 20, type: 'tool/call', data: { callId: 'generation-call', name: 'generate_image', arguments: '{}' } },
      {
        seq: 3,
        time: 30,
        type: 'tool/result',
        data: {
          message: { content: [{ type: 'tool-result', toolCallId: 'generation-call', content: [{ type: 'image', attachment: generated }] }] },
          meta: { images: [{ handle: 'image:generated', attachment: generated, origin: 'generated' }], references: [], warnings: [] },
        },
      },
      // A catalog replay must not change creation order or origin.
      { seq: 4, time: 40, type: 'tool/call', data: { callId: 'list-call', name: 'list_images', arguments: '{}' } },
      { seq: 5, time: 50, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'list-call', content: [{ type: 'image', attachment: user }] }] } } },
    ]
    const b = bench()

    const first = await execute(b.tools, 'list_images', { limit: 1 }, fakeAgent(events))

    expect(first.isError).toBe(false)
    if (first.isError) return
    expect(first.value).toMatchObject({
      items: [{
        handle: 'image:generated',
        name: 'generated.png',
        width: 1,
        height: 1,
        origin: 'generated',
        creationSeq: 3,
      }],
      nextCursor: expect.any(String),
    })
    expect(first.content).toEqual(expect.arrayContaining([
      { type: 'image', attachment: generated },
    ]))

    const cursor = (first.value as { nextCursor: string }).nextCursor
    const second = await execute(b.tools, 'list_images', { limit: 1, cursor }, fakeAgent(events))
    expect(second.isError).toBe(false)
    if (!second.isError) {
      expect(second.value).toMatchObject({
        items: [{ handle: 'image:user', origin: 'user', creationSeq: 1 }],
      })
      expect(second.value).not.toHaveProperty('nextCursor')
    }
  })

  it('advertises explicit reference discrimination and catalog controls in public schemas', () => {
    const schemas = bench().tools.schemas()
    const generate = schemas.find(schema => schema.name === 'generate_image')
    const list = schemas.find(schema => schema.name === 'list_images')
    expect(generate?.parameters).toMatchObject({
      properties: {
        prompt: { type: 'string' },
        references: {
          type: 'array',
          maxItems: 5,
          items: { oneOf: expect.any(Array) },
        },
        n: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['prompt'],
      additionalProperties: false,
    })
    expect(list?.parameters).toMatchObject({
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        cursor: { type: 'string' },
        origin: { enum: ['all', 'generated', 'reference', 'user'] },
      },
      additionalProperties: false,
    })
  })
})
