/** Live Codex catalog overlay and context-capacity policy owned by the LLM route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'

/** Durable settings namespace for Codex LLM route preferences. */
export const CODEX_LLM_SETTINGS_NAMESPACE = 'codex-llm'
/** Conservative Codex default that avoids automatic long-context usage. */
export const CODEX_STANDARD_CONTEXT_WINDOW = 272_000
/** Legacy opt-in budget for the supported GPT-5.6 family. */
export const CODEX_LONG_CONTEXT_WINDOW = 1_000_000
/** GPT-6 Codex OAuth maximum, distinct from public API total-context limits. */
export const CODEX_GPT_6_LONG_CONTEXT_WINDOW = 872_000
/** GPT-6 model ids exposed on the Codex route. */
export const CODEX_GPT_6_ASTRA_MODEL_ID = 'gpt-6-astra'
export const CODEX_GPT_6_SOL_MODEL_ID = 'gpt-6-sol'
export const CODEX_GPT_6_LUNA_MODEL_ID = 'gpt-6-luna'
export const CODEX_GPT_6_1_SOL_MODEL_ID = 'gpt-6.1-sol'

/** Models with a model-specific opt-in long-context budget. */
export const CODEX_LONG_CONTEXT_MODEL_IDS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  CODEX_GPT_6_ASTRA_MODEL_ID,
  CODEX_GPT_6_SOL_MODEL_ID,
  CODEX_GPT_6_LUNA_MODEL_ID,
  CODEX_GPT_6_1_SOL_MODEL_ID,
] as const

const LONG_CONTEXT_MODEL_IDS = new Set<string>(CODEX_LONG_CONTEXT_MODEL_IDS)

/**
 * GPT-6 pricing per million tokens. Above 272K input, input/cache rates
 * double and output rates increase by 50% for the entire request.
 */
function gpt6Cost(input: number, output: number, cacheRead: number, cacheWrite: number): Model<Api>['cost'] {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    tiers: [{
      inputTokensAbove: CODEX_STANDARD_CONTEXT_WINDOW,
      input: input * 2,
      output: output * 1.5,
      cacheRead: cacheRead * 2,
      cacheWrite: cacheWrite * 2,
    }],
  }
}

const GPT_6_THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies NonNullable<Model<Api>['thinkingLevelMap']>

const GPT_6_MODELS = [
  {
    id: CODEX_GPT_6_ASTRA_MODEL_ID,
    templateId: 'gpt-5.6-sol',
    name: 'GPT-6 Astra',
    cost: gpt6Cost(10, 50, 1, 12.5),
    thinkingLevelMap: GPT_6_THINKING_LEVEL_MAP,
  },
  {
    id: CODEX_GPT_6_SOL_MODEL_ID,
    templateId: 'gpt-5.6-sol',
    name: 'GPT-6 Sol',
    cost: gpt6Cost(2, 10, 0.2, 2.5),
    thinkingLevelMap: GPT_6_THINKING_LEVEL_MAP,
  },
  {
    id: CODEX_GPT_6_LUNA_MODEL_ID,
    templateId: 'gpt-5.6-luna',
    name: 'GPT-6 Luna',
    cost: gpt6Cost(0.1, 0.5, 0.01, 0.125),
    thinkingLevelMap: GPT_6_THINKING_LEVEL_MAP,
  },
  {
    id: CODEX_GPT_6_1_SOL_MODEL_ID,
    templateId: 'gpt-5.6-sol',
    name: 'GPT-6.1 Sol',
    // Public API price estimate; not a ChatGPT subscription quota conversion.
    cost: gpt6Cost(2, 10, 0.1, 2.5),
    thinkingLevelMap: GPT_6_THINKING_LEVEL_MAP,
  },
] as const

const GPT_6_MODEL_IDS = new Set<string>(GPT_6_MODELS.map(model => model.id))

/** Codex catalog source and API estimate provenance: docs/codex-model-policy.md. */
export function codexLongContextWindow(modelId: string): number | undefined {
  if (!LONG_CONTEXT_MODEL_IDS.has(modelId)) return undefined
  return GPT_6_MODEL_IDS.has(modelId) ? CODEX_GPT_6_LONG_CONTEXT_WINDOW : CODEX_LONG_CONTEXT_WINDOW
}

/** Independently live settings that affect the openai-codex model catalog. */
export interface CodexLlmSettings {
  longContextEnabled: boolean
}

export const CodexLlmSettingsConfig: z<CodexLlmSettings> = z.object({
  longContextEnabled: z.boolean().default(false),
})

/**
 * Keep the generated pi-ai catalog intact and overlay GPT-6 models only when
 * that installed catalog omits them. Enabling Long Context Mode then changes
 * only the known long-context family; every other descriptor and every
 * non-capacity field remains provider-owned.
 */
export function applyCodexContextPolicy(
  models: readonly Model<Api>[],
  settings: CodexLlmSettings,
): readonly Model<Api>[] {
  const catalog = ensureCodexCatalogModels(models)
  if (!settings.longContextEnabled) return catalog
  return catalog.map(model => {
    const contextWindow = codexLongContextWindow(model.id)
    return contextWindow === undefined ? model : { ...model, contextWindow }
  })
}

function ensureCodexCatalogModels(models: readonly Model<Api>[]): readonly Model<Api>[] {
  const missing = GPT_6_MODELS.flatMap(descriptor => {
    if (models.some(model => model.id === descriptor.id)) return []
    const template = models.find(model => model.id === descriptor.templateId)
    if (template === undefined) return []
    return [{
      ...template,
      id: descriptor.id,
      name: descriptor.name,
      contextWindow: CODEX_STANDARD_CONTEXT_WINDOW,
      maxTokens: 128_000,
      cost: descriptor.cost,
      thinkingLevelMap: { ...descriptor.thinkingLevelMap },
    }]
  })
  return missing.length === 0 ? models : [...missing, ...models]
}
