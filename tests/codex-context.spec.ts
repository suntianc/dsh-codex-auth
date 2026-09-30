/** Catalog overlay and Long Context Mode policy for the openai-codex route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  applyCodexContextPolicy,
  CODEX_GPT_6_ASTRA_MODEL_ID,
  CODEX_GPT_6_1_SOL_MODEL_ID,
  CODEX_GPT_6_LONG_CONTEXT_WINDOW,
  CODEX_GPT_6_LUNA_MODEL_ID,
  CODEX_GPT_6_SOL_MODEL_ID,
  CODEX_LONG_CONTEXT_MODEL_IDS,
  CODEX_LONG_CONTEXT_WINDOW,
  CODEX_STANDARD_CONTEXT_WINDOW,
} from '../src/codex-context.ts'

function fakeModel(id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CODEX_STANDARD_CONTEXT_WINDOW,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' },
    compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true },
    ...extra,
  } as Model<Api>
}

describe('applyCodexContextPolicy', () => {
  it('overlays missing GPT-6 models from matching GPT-5.6 templates', () => {
    const sol = fakeModel('gpt-5.6-sol', { name: 'GPT-5.6 Sol' })
    const luna = fakeModel('gpt-5.6-luna', { name: 'GPT-5.6 Luna' })
    const terra = fakeModel('gpt-5.6-terra')
    const catalog = applyCodexContextPolicy([sol, luna, terra], { longContextEnabled: false })
    expect(catalog.map(model => model.id)).toEqual([
      CODEX_GPT_6_ASTRA_MODEL_ID,
      CODEX_GPT_6_SOL_MODEL_ID,
      CODEX_GPT_6_LUNA_MODEL_ID,
      CODEX_GPT_6_1_SOL_MODEL_ID,
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ])
    const astra = catalog[0]
    expect(astra).toMatchObject({
      id: CODEX_GPT_6_ASTRA_MODEL_ID,
      name: 'GPT-6 Astra',
      api: sol.api,
      provider: sol.provider,
      baseUrl: sol.baseUrl,
      contextWindow: CODEX_STANDARD_CONTEXT_WINDOW,
      compat: sol.compat,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
    })
    expect(astra.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: 'low',
      low: 'low',
      max: 'max',
    })
    for (const [id, template, cost] of [
      [CODEX_GPT_6_SOL_MODEL_ID, sol, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] }],
      [CODEX_GPT_6_LUNA_MODEL_ID, luna, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
        tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] }],
      [CODEX_GPT_6_1_SOL_MODEL_ID, sol, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] }],
    ] as const) {
      const model = catalog.find(item => item.id === id)
      expect(model).toMatchObject({
        id,
        api: template.api,
        provider: template.provider,
        baseUrl: template.baseUrl,
        input: ['text', 'image'],
        contextWindow: CODEX_STANDARD_CONTEXT_WINDOW,
        maxTokens: 128_000,
        compat: template.compat,
        cost,
        thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      })
    }
  })

  it('preserves installed GPT-6 rows while filling only missing siblings', () => {
    const astra = fakeModel(CODEX_GPT_6_ASTRA_MODEL_ID, { name: 'Installed Astra' })
    const luna = fakeModel(CODEX_GPT_6_LUNA_MODEL_ID, { name: 'Installed Luna' })
    const models = [astra, luna, fakeModel('gpt-5.6-sol'), fakeModel('gpt-5.6-luna')]
    const catalog = applyCodexContextPolicy(models, { longContextEnabled: false })
    expect(catalog.find(model => model.id === CODEX_GPT_6_ASTRA_MODEL_ID)).toBe(astra)
    expect(catalog.find(model => model.id === CODEX_GPT_6_LUNA_MODEL_ID)).toBe(luna)
    expect(catalog.filter(model => model.id === CODEX_GPT_6_SOL_MODEL_ID)).toHaveLength(1)
    const allInstalled = [astra, luna, fakeModel(CODEX_GPT_6_SOL_MODEL_ID), fakeModel(CODEX_GPT_6_1_SOL_MODEL_ID)]
    expect(applyCodexContextPolicy(allInstalled, { longContextEnabled: false })).toBe(allInstalled)
  })

  it('preserves every installed descriptor field except opt-in capacity and does not mutate inputs', () => {
    const installed = fakeModel(CODEX_GPT_6_1_SOL_MODEL_ID, {
      name: 'Provider-owned Sol', contextWindow: 300_000, maxTokens: 64_000,
      cost: { input: 7, output: 8, cacheRead: 1, cacheWrite: 2 },
      thinkingLevelMap: { off: null, low: 'low', max: 'max' },
    })
    Object.freeze(installed)
    const models = Object.freeze([installed])
    expect(applyCodexContextPolicy(models, { longContextEnabled: false })).toBe(models)
    const [long] = applyCodexContextPolicy(models, { longContextEnabled: true })
    expect(long).toEqual({ ...installed, contextWindow: CODEX_GPT_6_LONG_CONTEXT_WINDOW })
    expect(installed.contextWindow).toBe(300_000)
    expect(applyCodexContextPolicy(models, { longContextEnabled: false })[0]).toBe(installed)
  })

  it('does not invent GPT-6 Astra without a GPT-5.6 Sol template', () => {
    const models = [fakeModel('gpt-5.4'), fakeModel('gpt-5.6-terra')]
    expect(applyCodexContextPolicy(models, { longContextEnabled: false })).toBe(models)
  })

  it('applies model-specific long-context budgets only to known models', () => {
    const gpt54 = fakeModel('gpt-5.4')
    const catalog = applyCodexContextPolicy(
      [fakeModel('gpt-5.6-luna'), fakeModel('gpt-5.6-sol'), fakeModel('gpt-5.6-terra'), gpt54],
      { longContextEnabled: true },
    )
    for (const id of CODEX_LONG_CONTEXT_MODEL_IDS) {
      expect(catalog.find(model => model.id === id)?.contextWindow).toBe(
        id.startsWith('gpt-5.6-') ? CODEX_LONG_CONTEXT_WINDOW : CODEX_GPT_6_LONG_CONTEXT_WINDOW,
      )
    }
    expect(catalog.find(model => model.id === 'gpt-5.4')).toBe(gpt54)
  })
})
