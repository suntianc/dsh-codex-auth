/** Live GPT-5.6 context-capacity policy owned by the Codex LLM route. */
import type { Api, Model } from '@earendil-works/pi-ai'
import z from '@deepseek-ai/schemastery'

/** Durable settings namespace for Codex LLM route preferences. */
export const CODEX_LLM_SETTINGS_NAMESPACE = 'codex-llm'
/** Conservative Codex default that avoids automatic long-context usage. */
export const CODEX_STANDARD_CONTEXT_WINDOW = 272_000
/** Explicit opt-in budget matching Codex's documented one-million-token configuration. */
export const CODEX_LONG_CONTEXT_WINDOW = 1_000_000

const LONG_CONTEXT_MODEL_IDS = new Set([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
])

/** Independently live settings that affect the openai-codex model catalog. */
export interface CodexLlmSettings {
  longContextEnabled: boolean
}

export const CodexLlmSettingsConfig: z<CodexLlmSettings> = z.object({
  longContextEnabled: z.boolean().default(false),
})

/**
 * Apply the plugin's narrow context policy without mutating pi-ai's generated
 * catalog. Enabling the policy changes only the known GPT-5.6 family; every
 * other descriptor and every non-capacity field remains provider-owned.
 */
export function applyCodexContextPolicy(
  models: readonly Model<Api>[],
  settings: CodexLlmSettings,
): readonly Model<Api>[] {
  if (!settings.longContextEnabled) return models
  return models.map(model => LONG_CONTEXT_MODEL_IDS.has(model.id)
    ? { ...model, contextWindow: CODEX_LONG_CONTEXT_WINDOW }
    : model)
}
