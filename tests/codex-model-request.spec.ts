/** Exercise model policy through the real DSH/pi-ai adapter with offline transport. */
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAuthAdapter } from '../src/codex-auth-adapter.ts'
import {
  CODEX_GPT_6_ASTRA_MODEL_ID,
  CODEX_GPT_6_1_SOL_MODEL_ID,
  CODEX_GPT_6_LUNA_MODEL_ID,
  CODEX_GPT_6_SOL_MODEL_ID,
} from '../src/codex-context.ts'

const NEW_MODELS = [CODEX_GPT_6_SOL_MODEL_ID, CODEX_GPT_6_LUNA_MODEL_ID, CODEX_GPT_6_1_SOL_MODEL_ID] as const

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
})

function fixture() {
  context = new Context()
  const accountId = 'synthetic-model-policy-account'
  const token = ['header', Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url'), 'signature'].join('.')
  const credential = vi.fn(async () => ({ accessToken: token, accountId }))
  const payloads: Array<Record<string, unknown>> = []
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    let body = init?.body
    if (body instanceof Uint8Array) {
      const bytes = new Headers(init?.headers).get('content-encoding') === 'zstd'
        ? zstdDecompressSync(body) : body
      body = Buffer.from(bytes).toString('utf8')
    }
    if (typeof body !== 'string') throw new Error('Expected a serialized request body')
    payloads.push(JSON.parse(body) as Record<string, unknown>)
    // Exercise successful provider decoding offline; this is not a live backend probe.
    const events = [
      { type: 'response.output_item.done', output_index: 0, item: {
        type: 'message', id: 'msg_model_policy', role: 'assistant',
        content: [{ type: 'output_text', text: 'Model policy fixture response.' }],
      } },
      { type: 'response.completed', response: {
        id: 'resp_model_policy', status: 'completed',
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const adapter = new CodexAuthAdapter(context, {
    auth: { credential },
    authJsonPath: '/nonexistent/model-policy-auth.json',
    credentialRef: credentialRef('SYNTHETIC_MODEL_POLICY'),
    refreshLeadMs: 300_000,
    fetchImpl: fetchMock,
    displayName: 'Codex model policy fixture',
    settings: () => ({ longContextEnabled: false }),
    transport: 'sse',
    websocketConnectTimeoutMs: 1_000,
    timeoutMs: 1_000,
  })
  return { adapter, credential, fetchMock, payloads }
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'openai-codex',
    model: CODEX_GPT_6_ASTRA_MODEL_ID,
    system: 'Offline model policy fixture.',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Hello' }],
      source: { kind: 'user' },
    })],
    ...extra,
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume the scripted provider response */ }
}

describe('Codex model request policy', () => {
  describe.each(['direct', 'prepared'] as const)('%s adapter calls', mode => {
    it.each([0, 0.7])('rejects Astra temperature %s before resolving credentials', async temperature => {
      const { adapter, credential, fetchMock } = fixture()
      const options = request({ temperature })
      const call = mode === 'prepared'
        ? await adapter.prepareCall(options.provider, options.model)
        : adapter

      await expect(drain(call.stream(options))).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPTION',
        message: 'GPT-6 Astra does not support temperature; remove temperature from the model request',
      })
      expect(credential).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends Astra without temperature through the real provider', async () => {
      const { adapter, payloads } = fixture()
      const options = request()
      const call = mode === 'prepared'
        ? await adapter.prepareCall(options.provider, options.model)
        : adapter

      await drain(call.stream(options))

      expect(payloads).toHaveLength(1)
      expect(payloads[0]?.model).toBe(CODEX_GPT_6_ASTRA_MODEL_ID)
      expect(payloads[0]).not.toHaveProperty('temperature')
    })

    it.each(NEW_MODELS)('decodes a successful offline SSE response for %s', async model => {
      const { adapter, payloads } = fixture()
      const options = request({ model })
      const call = mode === 'prepared'
        ? await adapter.prepareCall(options.provider, options.model)
        : adapter

      const chunks = []
      for await (const chunk of call.stream(options)) chunks.push(chunk)
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'block-end', block: expect.objectContaining({ type: 'text', text: 'Model policy fixture response.' }),
      }))

      expect(payloads).toHaveLength(1)
      expect(payloads[0]?.model).toBe(model)
      expect(payloads[0]).not.toHaveProperty('temperature')
    })

    it.each(NEW_MODELS.flatMap(model => [0, 0.7].map(temperature => ({ model, temperature }))))(
      'rejects $model temperature $temperature before resolving credentials', async ({ model, temperature }) => {
        const { adapter, credential, fetchMock } = fixture()
        const options = request({ model, temperature, reasoningEffort: ReasoningEffortId('off') })
        const call = mode === 'prepared'
          ? await adapter.prepareCall(options.provider, options.model)
          : adapter

        await expect(drain(call.stream(options))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
        expect(credential).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )
  })

  it.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'preserves the Astra %s reasoning wire mapping', async level => {
      const { adapter, payloads } = fixture()
      await drain(adapter.stream(request({ reasoningEffort: ReasoningEffortId(level) })))

      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({
        model: CODEX_GPT_6_ASTRA_MODEL_ID,
        reasoning: { effort: level === 'minimal' ? 'low' : level },
      })
      expect(payloads[0]).not.toHaveProperty('temperature')
    },
  )

  describe.each(['direct', 'prepared'] as const)('%s GPT-6 reasoning', mode => {
    it.each(NEW_MODELS.flatMap(model => ['off', 'ultra'].map(level => ({ model, level }))))(
      'rejects unsupported $model $level before credentials or transport', async ({ model, level }) => {
        const { adapter, credential, fetchMock } = fixture()
        const options = request({ model, reasoningEffort: ReasoningEffortId(level) })
        const call = mode === 'prepared' ? await adapter.prepareCall(options.provider, options.model) : adapter
        await expect(drain(call.stream(options))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
        expect(credential).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )

    it.each(NEW_MODELS)('does not advertise Off or Ultra for %s', async model => {
      const { adapter } = fixture()
      const info = mode === 'prepared'
        ? (await adapter.prepareCall('openai-codex', model)).model
        : await adapter.resolveModel('openai-codex', model)
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('defaults GPT-6.1 Sol to Codex low without mutating caller options', async () => {
      const { adapter, payloads } = fixture()
      const options = Object.freeze(request({ model: CODEX_GPT_6_1_SOL_MODEL_ID }))
      const call = mode === 'prepared' ? await adapter.prepareCall(options.provider, options.model) : adapter
      await drain(call.stream(options))
      expect(payloads[0]).toMatchObject({ reasoning: { effort: 'low' } })
      expect(options).not.toHaveProperty('reasoningEffort')
    })

    it.each(NEW_MODELS.flatMap(model =>
      (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
        .map(level => ({ model, level })),
    ))('maps $model $level to the supported Codex wire effort', async ({ model, level }) => {
      const { adapter, payloads } = fixture()
      const options = request({ model, reasoningEffort: ReasoningEffortId(level) })
      const call = mode === 'prepared'
        ? await adapter.prepareCall(options.provider, options.model)
        : adapter

      await drain(call.stream(options))

      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({ reasoning: { effort: level === 'minimal' ? 'low' : level } })
    })
  })

  it('keeps temperature handling provider-owned for other models', async () => {
    const { adapter, payloads } = fixture()
    await drain(adapter.stream(request({ model: 'gpt-5.6-sol', temperature: 0.7 })))

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ model: 'gpt-5.6-sol', temperature: 0.7 })
  })
})
