/** Live Codex catalog overlay and context-capacity policy owned by the LLM route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'

/** Durable settings namespace for Codex LLM route preferences. */
export const CODEX_LLM_SETTINGS_NAMESPACE = 'codex-llm'
/** Conservative Codex default that avoids automatic long-context usage. */
export const CODEX_STANDARD_CONTEXT_WINDOW = 272_000
/** Explicit opt-in budget matching Codex's documented one-million-token configuration. */
export const CODEX_LONG_CONTEXT_WINDOW = 1_000_000
/** Current Codex flagship. Installed pi-ai 0.84.4 omits this descriptor. */
export const CODEX_GPT_6_ASTRA_MODEL_ID = 'gpt-6-astra'
/** Template used only when the installed catalog has no GPT-6 Astra row. */
const CODEX_GPT_6_ASTRA_TEMPLATE_ID = 'gpt-5.6-sol'

/** Models that may report the opt-in 1M context budget. */
export const CODEX_LONG_CONTEXT_MODEL_IDS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  CODEX_GPT_6_ASTRA_MODEL_ID,
] as const

const LONG_CONTEXT_MODEL_IDS = new Set<string>(CODEX_LONG_CONTEXT_MODEL_IDS)

/**
 * Official Codex GPT-6 Astra pricing and reasoning map from pi-ai 0.85.1.
 * `off` is unsupported; DSH `minimal` maps to `low`.
 */
const GPT_6_ASTRA_COST: Model<Api>['cost'] = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  tiers: [{
    inputTokensAbove: CODEX_STANDARD_CONTEXT_WINDOW,
    input: 20,
    output: 75,
    cacheRead: 2,
    cacheWrite: 25,
  }],
}

const GPT_6_ASTRA_THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies NonNullable<Model<Api>['thinkingLevelMap']>

/** Independently live settings that affect the openai-codex model catalog. */
export interface CodexLlmSettings {
  longContextEnabled: boolean
}

export const CodexLlmSettingsConfig: z<CodexLlmSettings> = z.object({
  longContextEnabled: z.boolean().default(false),
})

/**
 * Keep the generated pi-ai catalog intact and overlay GPT-6 Astra only when
 * that installed catalog omits it. Enabling Long Context Mode then changes
 * only the known long-context family; every other descriptor and every
 * non-capacity field remains provider-owned.
 */
export function applyCodexContextPolicy(
  models: readonly Model<Api>[],
  settings: CodexLlmSettings,
): readonly Model<Api>[] {
  const catalog = ensureCodexCatalogModels(models)
  if (!settings.longContextEnabled) return catalog
  return catalog.map(model => LONG_CONTEXT_MODEL_IDS.has(model.id)
    ? { ...model, contextWindow: CODEX_LONG_CONTEXT_WINDOW }
    : model)
}

function ensureCodexCatalogModels(models: readonly Model<Api>[]): readonly Model<Api>[] {
  if (models.some(model => model.id === CODEX_GPT_6_ASTRA_MODEL_ID)) return models
  const template = models.find(model => model.id === CODEX_GPT_6_ASTRA_TEMPLATE_ID)
  if (template === undefined) return models
  return [{
    ...template,
    id: CODEX_GPT_6_ASTRA_MODEL_ID,
    name: 'GPT-6 Astra',
    cost: GPT_6_ASTRA_COST,
    thinkingLevelMap: { ...GPT_6_ASTRA_THINKING_LEVEL_MAP },
  }, ...models]
}
