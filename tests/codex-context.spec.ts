/** Catalog overlay and Long Context Mode policy for the openai-codex route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  applyCodexContextPolicy,
  CODEX_GPT_6_ASTRA_MODEL_ID,
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
  it('overlays GPT-6 Astra from GPT-5.6 Sol when the installed catalog omits it', () => {
    const sol = fakeModel('gpt-5.6-sol', { name: 'GPT-5.6 Sol' })
    const terra = fakeModel('gpt-5.6-terra')
    const catalog = applyCodexContextPolicy([sol, terra], { longContextEnabled: false })
    expect(catalog.map(model => model.id)).toEqual([
      CODEX_GPT_6_ASTRA_MODEL_ID,
      'gpt-5.6-sol',
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
  })

  it('leaves an installed GPT-6 Astra descriptor in place', () => {
    const astra = fakeModel(CODEX_GPT_6_ASTRA_MODEL_ID, { name: 'Installed Astra' })
    const models = [astra, fakeModel('gpt-5.6-sol')]
    expect(applyCodexContextPolicy(models, { longContextEnabled: false })).toBe(models)
  })

  it('does not invent GPT-6 Astra without a GPT-5.6 Sol template', () => {
    const models = [fakeModel('gpt-5.4'), fakeModel('gpt-5.6-terra')]
    expect(applyCodexContextPolicy(models, { longContextEnabled: false })).toBe(models)
  })

  it('applies the 1M budget only to the known long-context family', () => {
    const gpt54 = fakeModel('gpt-5.4')
    const catalog = applyCodexContextPolicy(
      [fakeModel('gpt-5.6-luna'), fakeModel('gpt-5.6-sol'), fakeModel('gpt-5.6-terra'), gpt54],
      { longContextEnabled: true },
    )
    for (const id of CODEX_LONG_CONTEXT_MODEL_IDS) {
      expect(catalog.find(model => model.id === id)?.contextWindow).toBe(CODEX_LONG_CONTEXT_WINDOW)
    }
    expect(catalog.find(model => model.id === 'gpt-5.4')).toBe(gpt54)
  })
})
