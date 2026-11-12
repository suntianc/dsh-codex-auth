/** Exercise model policy through the real DSH/pi-ai adapter with offline transport. */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { codexJsonFetch } from '../src/codex-transport.ts'
import { CodexAuthAdapter } from '../src/codex-auth-adapter.ts'
import {
  CODEX_GPT_6_ASTRA_MODEL_ID,
  CODEX_GPT_6_1_SOL_MODEL_ID,
  CODEX_GPT_6_LUNA_MODEL_ID,
  CODEX_GPT_6_SOL_MODEL_ID,
} from '../src/codex-context.ts'
import type { CodexLlmSettings } from '../src/codex-context.ts'

const NEW_MODELS = [CODEX_GPT_6_SOL_MODEL_ID, CODEX_GPT_6_LUNA_MODEL_ID, CODEX_GPT_6_1_SOL_MODEL_ID] as const

const fallbackCatalog = vi.hoisted(() => ({ enabled: false }))
vi.mock('@earendil-works/pi-ai/providers/all', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>()
  return {
    ...actual,
    builtinProviders: () => actual.builtinProviders().map(provider =>
      provider.id !== 'openai-codex' || !fallbackCatalog.enabled ? provider : {
        ...provider,
        getModels: () => provider.getModels().filter(model => !NEW_MODELS.some(id => id === model.id)),
      }),
  }
})

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  fallbackCatalog.enabled = false
})

function fixture(fallback = false, settings: CodexLlmSettings = { longContextEnabled: false }, fastModeForSession?: (sessionId?: string) => boolean | undefined) {
  fallbackCatalog.enabled = fallback
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
    settings: () => settings,
    ...fastModeForSession === undefined ? {} : { fastModeForSession },
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
  it.each(['direct', 'prepared'] as const)('sends %s Codex SSE requests as uncompressed JSON', async mode => {
    const { adapter, fetchMock, payloads } = fixture()
    const options = request({ reasoningEffort: ReasoningEffortId('high') })
    const call = mode === 'prepared' ? await adapter.prepareCall(options.provider, options.model) : adapter
    await drain(call.stream(options))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]![1]!
    expect(new Headers(init.headers).has('content-encoding')).toBe(false)
    expect(typeof init.body).toBe('string')
    expect(payloads[0]).toMatchObject({
      model: CODEX_GPT_6_ASTRA_MODEL_ID,
      reasoning: { effort: 'high' },
    })
  })

  it('keeps explicit per-session Fast on/off separate from the profile and other sessions', async () => {
    const settings = { longContextEnabled: false, fastModeEnabled: true }
    const overrides = new Map([['fast-session', true], ['standard-session', false]])
    const { adapter, payloads } = fixture(false, settings, id => overrides.get(id ?? ''))
    for (const id of ['fast-session', 'standard-session', 'new-session']) {
      await drain(adapter.stream(request({ sessionId: id as NonNullable<GenerateOptions['sessionId']> })))
    }
    expect(payloads.map(payload => payload.service_tier)).toEqual(['priority', 'default', 'priority'])
    expect(settings.fastModeEnabled).toBe(true)
  })

  it.each(['direct', 'prepared'] as const)('applies live Fast mode to %s calls without changing model or reasoning', async mode => {
    const settings = { longContextEnabled: false, fastModeEnabled: false }
    const { adapter, payloads } = fixture(false, settings)
    const options = request({ reasoningEffort: ReasoningEffortId('high') })
    const call = mode === 'prepared' ? await adapter.prepareCall(options.provider, options.model) : adapter
    await drain(call.stream(options))
    settings.fastModeEnabled = true
    await drain(call.stream(options))
    settings.fastModeEnabled = false
    await drain(call.stream(options))
    expect(payloads.map(payload => payload.service_tier)).toEqual([undefined, 'priority', undefined])
    for (const payload of payloads) {
      expect(payload.model).toBe(options.model)
      expect(payload.reasoning).toMatchObject({ effort: 'high' })
    }
    const { service_tier: _tier, ...fast } = payloads[1]!
    expect(fast).toEqual(payloads[0])
    expect(payloads[2]).toEqual(payloads[0])
  })

  it('keeps the static catalog visible without resolving or refreshing Login State', async () => {
    const { adapter, credential, fetchMock } = fixture()
    credential.mockRejectedValue(new Error('Catalog access must not touch Login State'))
    expect((await adapter.listModels('openai-codex')).some(model => model.id === CODEX_GPT_6_SOL_MODEL_ID)).toBe(true)
    await expect(adapter.listModels('another-provider')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(credential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses host missing-model handling when a prepared call dispatches after exclusion', async () => {
    const settings: CodexLlmSettings = { longContextEnabled: false, excludedModelIds: [] }
    const { adapter, credential, fetchMock } = fixture(false, settings)
    const selected = request()
    const prepared = await adapter.prepareCall(selected.provider, selected.model)
    settings.excludedModelIds = [selected.model]
    adapter.replaceRouteGeneration()
    await expect(adapter.prepareCall(selected.provider, selected.model)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(drain(prepared.stream(selected))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(credential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the host missing-model error for excluded selections and empty catalogs before auth or transport', async () => {
    const settings: CodexLlmSettings = { longContextEnabled: false, excludedModelIds: [] }
    const { adapter, credential, fetchMock } = fixture(true, settings)
    const all = await adapter.listModels('openai-codex')
    const selected = request()
    settings.excludedModelIds = [selected.model, CODEX_GPT_6_1_SOL_MODEL_ID]
    adapter.replaceRouteGeneration()
    expect((await adapter.listModels('openai-codex')).some(model => model.id === selected.model)).toBe(false)
    await expect(adapter.resolveModel(selected.provider, selected.model)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(adapter.prepareCall(selected.provider, selected.model)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(drain(adapter.stream(selected))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(selected.model).toBe(CODEX_GPT_6_ASTRA_MODEL_ID)
    settings.excludedModelIds = all.map(model => model.id)
    adapter.replaceRouteGeneration()
    expect(await adapter.listModels('openai-codex')).toEqual([])
    await expect(adapter.resolveModel(selected.provider, selected.model)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(credential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    settings.excludedModelIds = []
    adapter.replaceRouteGeneration()
    expect(await adapter.listModels('openai-codex')).toEqual(all)
  })

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
      'rejects fallback $model $level before credentials or transport', async ({ model, level }) => {
        const { adapter, credential, fetchMock } = fixture(true)
        const options = request({ model, reasoningEffort: ReasoningEffortId(level) })
        const call = mode === 'prepared' ? await adapter.prepareCall(options.provider, options.model) : adapter
        await expect(drain(call.stream(options))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
        expect(credential).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      },
    )

    it.each(NEW_MODELS)('does not advertise fallback Off or Ultra for %s', async model => {
      const { adapter } = fixture(true)
      const info = mode === 'prepared'
        ? (await adapter.prepareCall('openai-codex', model)).model
        : await adapter.resolveModel('openai-codex', model)
      expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    })

    it.each([CODEX_GPT_6_SOL_MODEL_ID, CODEX_GPT_6_LUNA_MODEL_ID])(
      'preserves upstream %s Off support and rejects Ultra before authentication', async model => {
        const { adapter, credential, payloads, fetchMock } = fixture()
        const upstream = builtinProviders().find(provider => provider.id === 'openai-codex')
          ?.getModels().find(candidate => candidate.id === model)
        expect(upstream?.thinkingLevelMap?.off).toBe('none')
        const call = mode === 'prepared' ? await adapter.prepareCall('openai-codex', model) : adapter
        await expect(drain(call.stream(request({ model, reasoningEffort: ReasoningEffortId('ultra') }))))
          .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
        expect(credential).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
        await drain(call.stream(request({ model, reasoningEffort: ReasoningEffortId('off') })))
        expect(payloads[0]).toMatchObject({ model, reasoning: { effort: 'none' } })
      },
    )

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

describe('Codex JSON transport', () => {
  it('preserves payload bytes, credentials, cancellation and response without retrying a rejection', async () => {
    const payload = JSON.stringify({ model: 'gpt-6-astra', input: [{ type: 'reasoning', encrypted_content: 'synthetic-opaque-reasoning' }], instructions: 'Проверка' })
    const response = new Response('{"detail":"Bad Request"}', { status: 400 })
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
    const signal = new AbortController().signal
    const headers = new Headers({ 'content-encoding': 'zstd', 'content-length': '123', authorization: 'Bearer synthetic-token', 'content-type': 'application/json' })
    const init: RequestInit = { method: 'POST', headers, signal, body: new Uint8Array(zstdCompressSync(payload)) }
    expect(await codexJsonFetch(transport)('https://chatgpt.com/backend-api/codex/responses', init)).toBe(response)
    expect(transport).toHaveBeenCalledTimes(1)
    const sent = transport.mock.calls[0]![1]!
    expect(sent.body).toBe(payload)
    expect(sent.signal).toBe(signal)
    expect(sent.method).toBe('POST')
    expect(new Headers(sent.headers).get('authorization')).toBe('Bearer synthetic-token')
    expect(new Headers(sent.headers).get('content-type')).toBe('application/json')
    expect(new Headers(sent.headers).has('content-encoding')).toBe(false)
    expect(new Headers(sent.headers).has('content-length')).toBe(false)
    expect(headers.get('content-encoding')).toBe('zstd')
    expect(init.body).toBeInstanceOf(Uint8Array)
  })

  it('passes an uncompressed request through without modifying its arguments', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    const init = { method: 'POST', body: '{"input":"hello"}' }
    await codexJsonFetch(transport)('https://chatgpt.com/backend-api/codex/responses', init)
    expect(transport.mock.calls[0]![1]).toBe(init)
  })

  it('rejects an invalid compressed body before sending an HTTP request', () => {
    const transport = vi.fn<typeof fetch>()
    expect(() => codexJsonFetch(transport)('https://chatgpt.com/backend-api/codex/responses', {
      headers: { 'content-encoding': 'zstd' }, body: 'not compressed bytes',
    })).toThrow('Codex zstd request requires a byte buffer')
    expect(transport).not.toHaveBeenCalled()
  })
})
