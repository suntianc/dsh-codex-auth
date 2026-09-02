/**
 * Experimental Dual Checkpoint Adapter for custom Codex agent presets.
 *
 * Native generation deepens BasicCompactionEngine's public manual and automatic
 * entries plus its protected summarization Seam; every compaction decision and
 * durable mutation remains owned by the inherited Basic lifecycle.
 *
 * @module dsh-codex-auth/compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE } from './native-checkpoint.ts'
import { codexNativeCompactionCoordinator } from './native-compaction.ts'
import type { CodexNativeCompactionDiagnostic } from './native-compaction.ts'
import { installedPackageVersion } from './package-version.ts'

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

/** Conservative allowance for Basic's private framing around returned summary blocks. */
const BASIC_FRAME_TOKEN_RESERVE = 256

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

/** Read the installed versions that own the Basic transaction and pi conversion. */
function installedRuntimeVersions(): CodexCompactionRuntimeVersions {
  const dsh = Object.fromEntries(DSH_RUNTIME_PACKAGES.map(specifier => [
    specifier,
    installedPackageVersion(specifier, import.meta.url),
  ])) as Record<DshRuntimePackage, string>
  return {
    dsh,
    piAi: installedPackageVersion('@earendil-works/pi-ai', import.meta.url),
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

type ManualCommandId = Parameters<BasicCompactionEngine['compactNow']>[2]
type AutomaticCompactionTrigger = Parameters<BasicCompactionEngine['compactIfNeeded']>[1]

function currentRoutedTarget(agent: Agent): { provider: string; model: string } | undefined {
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  const { provider, model } = agent.options
  if (provider === undefined || provider.length === 0
    || model === undefined || model.length === 0) return undefined
  return { provider, model }
}

/** Match Agent-loop replay semantics: inherit only a user-pinned reasoning effort. */
function currentExplicitReasoningEffort(agent: Agent) {
  const header = agent.session.requestHeader()
  return header?.adapterDefaults?.reasoningEffort === true
    ? undefined
    : header?.config.reasoningEffort
}

function currentCompactionId(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'compaction/start') return String(event.data.compactionId)
  }
  return undefined
}

function logNativeDiagnostic(
  ctx: Context,
  diagnostic: CodexNativeCompactionDiagnostic,
): void {
  const identity = [
    diagnostic.compactionId,
    diagnostic.trigger,
    diagnostic.codec,
    diagnostic.codecGeneration,
    diagnostic.model,
  ] as const
  if (diagnostic.event === 'eligibility') {
    ctx.logger.debug(
      'codex-compaction: event=eligibility compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s eligibility=%s',
      ...identity,
      diagnostic.eligibility,
    )
    return
  }
  if (diagnostic.event === 'attempt') {
    ctx.logger.debug(
      'codex-compaction: event=attempt compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s breakerState=%s requestBytes=%d',
      ...identity,
      diagnostic.breakerState,
      diagnostic.requestBytes,
    )
    return
  }
  if (diagnostic.event === 'response') {
    ctx.logger.debug(
      'codex-compaction: event=response compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s durationMs=%d outputItems=%d ignoredOutputItems=%d artifactBytes=%d opaqueBytes=%d usageAvailability=%s',
      ...identity,
      diagnostic.durationMs,
      diagnostic.outputItems,
      diagnostic.ignoredOutputItems,
      diagnostic.artifactBytes,
      diagnostic.opaqueBytes,
      diagnostic.usageAvailability,
    )
    return
  }
  if (diagnostic.event === 'candidate') {
    ctx.logger.debug(
      'codex-compaction: event=candidate compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s checkpointBytes=%d replayTokens=%d',
      ...identity,
      diagnostic.checkpointBytes,
      diagnostic.replayTokens,
    )
    return
  }
  if (diagnostic.event === 'result') {
    ctx.logger.debug(
      'codex-compaction: event=result compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s result=%s',
      ...identity,
      diagnostic.result,
    )
    return
  }
  if (diagnostic.reason === 'auth') {
    ctx.logger.warn(
      'codex-compaction: event=fallback compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s breakerState=%s durationMs=%s reason=auth; run "codex login"; retaining the Portable Checkpoint',
      ...identity,
      diagnostic.breakerState,
      diagnostic.durationMs === undefined ? 'unavailable' : String(diagnostic.durationMs),
    )
    return
  }
  ctx.logger.debug(
    'codex-compaction: event=fallback compactionId=%s trigger=%s codec=%s codecGeneration=%d model=%s breakerState=%s durationMs=%s reason=%s',
    ...identity,
    diagnostic.breakerState,
    diagnostic.durationMs === undefined ? 'unavailable' : String(diagnostic.durationMs),
    diagnostic.reason,
  )
}

function classifyCommit(result: { readonly summary: readonly ContentBlock[] } | null): {
  readonly committedNative: boolean
  readonly diagnostic: 'dual-committed' | 'no-commit' | 'portable-committed'
} {
  const committedNative = result?.summary.some(
    block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  ) ?? false
  return {
    committedNative,
    diagnostic: result === null
      ? 'no-commit'
      : committedNative ? 'dual-committed' : 'portable-committed',
  }
}

function dualSummaryClearlyShrinks(
  input: PortableSummarizationInput,
  summary: readonly ContentBlock[],
  estimateMessage: (message: Message) => number,
): boolean {
  const shadowedEstimate = input.messages.reduce(
    (total, message) => total + estimateMessage(message),
    0,
  )
  const unframedEstimate = estimateMessage(createUserMessage({
    content: [...summary],
    source: { kind: 'plugin', plugin: name },
  }))
  return unframedEstimate + BASIC_FRAME_TOKEN_RESERVE < shadowedEstimate
}

/**
 * Basic-derived Adapter that preserves Basic's transaction while augmenting one
 * eligible manual or automatic Portable summary with a Native Checkpoint.
 */
export class CodexCompactionEngine extends BasicCompactionEngine {
  private readonly lifecycleController = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    assertCodexCompactionCompatibility()
    super(ctx, config)
    ctx.effect(
      () => () => this.lifecycleController.abort(
        new Error('codex native compaction: Adapter realm disposed'),
      ),
      'codex-compaction: active request cleanup',
    )
  }

  private operationSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifecycleController.signal])
  }

  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: ManualCommandId,
  ): Promise<Awaited<ReturnType<BasicCompactionEngine['compactNow']>>> {
    const operationSignal = this.operationSignal(signal)
    const target = currentRoutedTarget(agent)
    const diagnosticModel = target?.model ?? 'unrouted'
    return codexNativeCompactionCoordinator.runManual({
      sessionId: String(agent.session.id),
      target,
      signal: operationSignal,
      diagnostic: diagnostic => logNativeDiagnostic(this.ctx, diagnostic),
    }, async () => {
      try {
        const result = await super.compactNow(agent, operationSignal, sourceCommandId)
        const commit = classifyCommit(result)
        codexNativeCompactionCoordinator.noteResult(diagnosticModel, commit.diagnostic)
        return result
      } catch (error) {
        codexNativeCompactionCoordinator.noteResult(diagnosticModel, 'failed')
        throw error
      }
    })
  }

  override compactIfNeeded(
    agent: Agent,
    trigger: AutomaticCompactionTrigger,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<BasicCompactionEngine['compactIfNeeded']>>> {
    const operationSignal = this.operationSignal(signal)
    const target = currentRoutedTarget(agent)
    const diagnosticModel = target?.model ?? 'unrouted'
    return codexNativeCompactionCoordinator.runAutomatic({
      agent,
      trigger,
      target,
      signal: operationSignal,
      diagnostic: diagnostic => logNativeDiagnostic(this.ctx, diagnostic),
    }, async () => {
      try {
        const result = await super.compactIfNeeded(agent, trigger, operationSignal)
        const commit = classifyCommit(result)
        codexNativeCompactionCoordinator.commitAutomaticContinuation(commit.committedNative)
        codexNativeCompactionCoordinator.noteResult(diagnosticModel, commit.diagnostic)
        return result
      } catch (error) {
        codexNativeCompactionCoordinator.commitAutomaticContinuation(false)
        codexNativeCompactionCoordinator.noteResult(diagnosticModel, 'failed')
        throw error
      }
    })
  }

  protected override summarize(
    input: PortableSummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<PortableSummaryResult> {
    const compactionId = currentCompactionId(agent)
    if (compactionId !== undefined) {
      codexNativeCompactionCoordinator.noteCompactionId(compactionId)
    }
    return codexNativeCompactionCoordinator.withPortableCapture(
      input.messages,
      signal,
      currentExplicitReasoningEffort(agent),
      async () => {
        const portable = await super.summarize(input, agent, signal)
        const native = await codexNativeCompactionCoordinator.createCheckpoint(
          input.messages,
          portable.provider,
          portable.model,
          signal,
        )
        if (native === undefined) return portable
        const summary = [...portable.summary, native]
        if (!dualSummaryClearlyShrinks(
          input,
          summary,
          message => this.ctx.tokenMeter.estimateMessage(message),
        )) {
          codexNativeCompactionCoordinator.noteStrictShrink(portable.model)
          return portable
        }
        return { ...portable, summary }
      },
    )
  }
}

/** Mount the experimental Adapter inside a user-authored custom preset realm. */
export function apply(ctx: Context, config: Config = {}): void {
  codexNativeCompactionCoordinator.installAutomaticBoundaries(ctx)
  void new CodexCompactionEngine(ctx, config)
}
