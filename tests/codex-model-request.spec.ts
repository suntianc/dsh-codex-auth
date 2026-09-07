/** Exercise model policy through the real DSH/pi-ai adapter with offline transport. */
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAuthAdapter } from '../src/codex-auth-adapter.ts'
import { CODEX_GPT_6_ASTRA_MODEL_ID } from '../src/codex-context.ts'

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
    // Capture the final wire body, then stop without contacting the provider.
    return new Response('model policy fixture stop', { status: 400 })
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

  it('keeps temperature handling provider-owned for other models', async () => {
    const { adapter, payloads } = fixture()
    await drain(adapter.stream(request({ model: 'gpt-5.6-sol', temperature: 0.7 })))

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({ model: 'gpt-5.6-sol', temperature: 0.7 })
  })
})
