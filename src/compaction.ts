/**
 * Experimental Portable Checkpoint Adapter for custom Codex agent presets.
 *
 * This first slice deliberately delegates every compaction decision and durable
 * mutation to BasicCompactionEngine. Later Native Checkpoint work deepens only
 * the protected summarization Seam without replacing the Basic lifecycle.
 *
 * @module dsh-codex-auth/compaction
 */

import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type {
  ContentBlock,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** The replayed prefix accepted by Basic's protected summarization Seam. */
interface PortableSummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** The complete result contract returned by Basic's protected summarization Seam. */
type PortableSummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | {
    rawOutput: ContentBlock[]
    llmStreamCall: true
  }
  | {
    rawOutput?: ContentBlock[]
    llmStreamCall?: never
  }
)

const DSH_RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter',
] as const

type DshRuntimePackage = typeof DSH_RUNTIME_PACKAGES[number]

/** Exact runtime pair whose rc.2 framing and pi conversion behavior this Adapter uses. */
export const CODEX_COMPACTION_COMPATIBILITY = Object.freeze({
  dsh: '0.1.1-rc.2',
  piAi: '0.82.1',
})

/** Runtime facts accepted by the compatibility assertion. */
export interface CodexCompactionRuntimeVersions {
  readonly dsh: Readonly<Record<DshRuntimePackage, string>>
  readonly piAi: string
}

/** Resolve one installed package version without importing a private package subpath. */
function installedPackageVersion(specifier: string): string {
  const packagePath = findPackageJSON(specifier, import.meta.url)
  if (packagePath === undefined) return 'unresolved'
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** Read the installed versions that own the Basic transaction and pi conversion. */
function installedRuntimeVersions(): CodexCompactionRuntimeVersions {
  const dsh = Object.fromEntries(DSH_RUNTIME_PACKAGES.map(specifier => [
    specifier,
    installedPackageVersion(specifier),
  ])) as Record<DshRuntimePackage, string>
  return {
    dsh,
    piAi: installedPackageVersion('@earendil-works/pi-ai'),
  }
}

/**
 * Refuse an unverified runtime before mounting the experimental Adapter.
 * The stock DSH preset remains the supported fallback for every other pair.
 */
export function assertCodexCompactionCompatibility(
  actual: CodexCompactionRuntimeVersions = installedRuntimeVersions(),
): void {
  const dshCompatible = DSH_RUNTIME_PACKAGES.every(
    specifier => actual.dsh[specifier] === CODEX_COMPACTION_COMPATIBILITY.dsh,
  )
  if (dshCompatible && actual.piAi === CODEX_COMPACTION_COMPATIBILITY.piAi) return
  const receivedDsh = DSH_RUNTIME_PACKAGES
    .map(specifier => `${specifier}=${actual.dsh[specifier]}`)
    .join(', ')
  throw new Error(
    `codex-compaction requires DSH ${CODEX_COMPACTION_COMPATIBILITY.dsh} across `
    + `${DSH_RUNTIME_PACKAGES.join(', ')} and @earendil-works/pi-ai `
    + `${CODEX_COMPACTION_COMPATIBILITY.piAi}; received ${receivedDsh}; `
    + `@earendil-works/pi-ai=${actual.piAi}`,
  )
}

/** Stable Loader id for the experimental custom-preset Adapter. */
export const name = 'codex-compaction'
/** Preserve Basic's dependency Interface at the custom Loader Seam. */
export const inject = BasicCompactionEngine.inject
/** Preserve Basic's validated configuration Interface. */
export const Config = BasicCompactionEngine.Config
export type Config = BasicCompactionConfig

/**
 * Basic-derived Adapter reserved for future Codex Native Checkpoint behavior.
 * It is Portable-only in this slice and intentionally changes no lifecycle.
 */
export class CodexCompactionEngine extends BasicCompactionEngine {
  constructor(ctx: Context, config: Config = {}) {
    assertCodexCompactionCompatibility()
    super(ctx, config)
  }

  protected override summarize(
    input: PortableSummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<PortableSummaryResult> {
    return super.summarize(input, agent, signal)
  }
}

/** Mount the experimental Adapter inside a user-authored custom preset realm. */
export function apply(ctx: Context, config: Config = {}): void {
  void new CodexCompactionEngine(ctx, config)
}
