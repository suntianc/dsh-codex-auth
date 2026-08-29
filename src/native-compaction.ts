import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { StreamOptions } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  CODEX_NATIVE_CHECKPOINT_CODEC,
  CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
  CODEX_NATIVE_CHECKPOINT_ESTIMATOR,
  CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION,
  CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY,
  CODEX_NATIVE_CHECKPOINT_SCHEMA_VERSION,
  MAX_CODEX_NATIVE_CHECKPOINT_BYTES,
  codexNativeCheckpointCompatibilityDigest,
  encodeCodexNativeCheckpoint,
  hashCodexAccountIdentity,
} from './native-checkpoint.ts'
import type {
  CodexNativeCheckpointBlock,
  CodexNativeCheckpointUsage,
  CodexNativeCheckpointV1,
  CodexResponsesItem,
  JsonValue,
} from './native-checkpoint.ts'
import {
  NativeCompactionFailure,
  nativeCompactionBreaker,
  nativeCompactionBreakerKey,
} from './native-compaction-breaker.ts'
import type { NativeCompactionBreakerLease } from './native-compaction-breaker.ts'
import {
  codexTurnStateContinuity,
} from './codex-turn-state.ts'
import type {
  CodexAdapterGeneration,
  CodexTurnStateContinuationInput,
} from './codex-turn-state.ts'
import {
  CODEX_NATIVE_RETENTION_TOKEN_BUDGET,
  estimateCodexJsonTokens,
  retainRecentCodexUserMessages,
} from './native-compaction-retention.ts'
import {
  codexResponsesUrl,
  sendCodexNativeCompaction,
} from './native-compaction-transport.ts'
import type { CodexNativeTransportRequest } from './native-compaction-transport.ts'
import {
  isPlainJsonTree,
  isPlainRecord,
  serializedJsonBytes,
  utf8ByteLength,
} from './json-tree.ts'

const CODEX_ROUTE = 'openai-codex'

type NativeCompactionTrigger = 'manual' | 'pressure' | 'context-overflow'
type AutomaticCompactionTrigger = Exclude<NativeCompactionTrigger, 'manual'>

type NativeCompactionFallback =
  | 'auth'
  | 'circuit-open'
  | 'protocol'
  | 'rate-limit'
  | 'size'
  | 'strict-shrink'
  | 'transient'
  | 'unsupported-payload'

type NativeCompactionDiagnosticDetail =
  | {
    readonly event: 'eligibility'
    readonly eligibility: 'eligible' | 'ineligible'
  }
  | {
    readonly event: 'attempt'
    readonly breakerState: 'closed' | 'half-open'
    readonly requestBytes: number
  }
  | {
    readonly event: 'response'
    readonly durationMs: number
    readonly outputItems: number
    readonly ignoredOutputItems: number
    readonly artifactBytes: number
    readonly opaqueBytes: number
    readonly usage: { readonly source: 'unavailable' } | CodexNativeCheckpointUsage
  }
  | {
    readonly event: 'candidate'
    readonly checkpointBytes: number
    readonly replayTokens: number
  }
  | {
    readonly event: 'fallback'
    readonly breakerState: 'closed' | 'half-open' | 'not-acquired' | 'open'
    readonly durationMs?: number
    readonly reason: NativeCompactionFallback
  }
  | {
    readonly event: 'result'
    readonly result: 'dual-committed' | 'failed' | 'no-commit' | 'portable-committed'
  }

export type CodexNativeCompactionDiagnostic = {
  readonly codec: typeof CODEX_NATIVE_CHECKPOINT_CODEC
  readonly codecGeneration: typeof CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION
  readonly compactionId: string
  readonly model: string
  readonly trigger: NativeCompactionTrigger
} & NativeCompactionDiagnosticDetail

interface RoutedTarget {
  readonly provider: string
  readonly model: string
}

interface AutomaticBoundary {
  readonly agent: Agent
  readonly trigger: AutomaticCompactionTrigger
}

interface CompactionOperation {
  readonly sessionId: string
  readonly target: RoutedTarget | undefined
  readonly callerSignal: AbortSignal
  readonly diagnostic: (diagnostic: CodexNativeCompactionDiagnostic) => void
  readonly windowId: string
  readonly trigger: NativeCompactionTrigger
  readonly inline: boolean
  compactionId: string | undefined
  continuation: CodexTurnStateContinuationInput | undefined
  phase: PortablePhase | undefined
}

interface PortablePhase {
  readonly input: readonly Message[]
  readonly signal: AbortSignal | undefined
  credential: CapturedCredential | undefined
  providerRequest: CapturedProviderRequest | undefined
  instructionText: string | undefined
  payload: Record<string, JsonValue> | undefined
}

interface CapturedCredential {
  readonly accessToken: string
  readonly accountId?: string
}

interface CapturedProviderRequest extends CodexNativeTransportRequest {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly adapterGeneration: CodexAdapterGeneration
}

interface ProviderRequestInput {
  readonly provider: string
  readonly model: string
  readonly baseUrl?: string
  readonly sessionId?: string
  readonly headers?: Readonly<Record<string, string | null>>
  readonly modelHeaders?: Readonly<Record<string, string>>
  readonly fetchImpl: typeof fetch
  readonly timeoutMs: number
  readonly streamIdleTimeoutMs: number
}

interface NativeRequest {
  readonly body: Record<string, JsonValue>
  readonly semanticInput: {
    readonly instructions: string
    readonly tools: JsonValue
    readonly parallelToolCalls: boolean
    readonly toolChoice: JsonValue
    readonly reasoning: JsonValue
    readonly text: JsonValue
    readonly serviceTier: JsonValue
  }
}

type PayloadCallback = NonNullable<StreamOptions['onPayload']>

/**
 * Host-only coordinator joining one inherited Basic operation to the exact
 * Codex payload and credential resolved by its successful Portable summary.
 */
class CodexNativeCompactionCoordinator {
  private readonly storage = new AsyncLocalStorage<CompactionOperation>()
  private readonly boundaryStorage = new AsyncLocalStorage<AutomaticBoundary>()

  /** Install read-only wrappers before Basic registers its automatic listeners. */
  installAutomaticBoundaries(ctx: Context): void {
    ctx.on('agent/pre-step', (payload, next) => this.boundaryStorage.run(
      { agent: payload.agent, trigger: 'pressure' },
      next,
    ))
    ctx.on('agent/request-error', (payload, next) => this.boundaryStorage.run(
      { agent: payload.agent, trigger: 'context-overflow' },
      next,
    ))
  }

  runManual<T>(
    input: {
      readonly sessionId: string
      readonly target: RoutedTarget | undefined
      readonly signal: AbortSignal
      readonly diagnostic: (diagnostic: CodexNativeCompactionDiagnostic) => void
    },
    task: () => Promise<T>,
  ): Promise<T> {
    return this.runOperation({ ...input, trigger: 'manual', inline: false }, task)
  }

  /** Scope pressure/overflow without taking any lifecycle work away from Basic. */
  runAutomatic<T>(
    input: {
      readonly agent: Agent
      readonly trigger: AutomaticCompactionTrigger
      readonly target: RoutedTarget | undefined
      readonly signal: AbortSignal
      readonly diagnostic: (diagnostic: CodexNativeCompactionDiagnostic) => void
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const boundary = this.boundaryStorage.getStore()
    return this.runOperation({
      sessionId: String(input.agent.session.id),
      target: input.target,
      signal: input.signal,
      diagnostic: input.diagnostic,
      trigger: input.trigger,
      inline: boundary?.agent === input.agent && boundary.trigger === input.trigger,
    }, task)
  }

  /** Arm only after the inherited automatic transaction reports a Dual commit. */
  commitAutomaticContinuation(committedNative: boolean): void {
    const operation = this.storage.getStore()
    const continuation = operation?.continuation
    if (operation === undefined || continuation === undefined) return
    operation.continuation = undefined
    if (committedNative && operation.inline && operation.trigger !== 'manual') {
      codexTurnStateContinuity.arm(continuation)
    }
  }

  private runOperation<T>(
    input: {
      readonly sessionId: string
      readonly target: RoutedTarget | undefined
      readonly signal: AbortSignal
      readonly diagnostic: (diagnostic: CodexNativeCompactionDiagnostic) => void
      readonly trigger: NativeCompactionTrigger
      readonly inline: boolean
    },
    task: () => Promise<T>,
  ): Promise<T> {
    const operation: CompactionOperation = {
      sessionId: input.sessionId,
      target: input.target,
      callerSignal: input.signal,
      diagnostic: input.diagnostic,
      trigger: input.trigger,
      inline: input.inline,
      windowId: randomUUID(),
      compactionId: undefined,
      continuation: undefined,
      phase: undefined,
    }
    return this.storage.run(operation, async () => {
      try {
        return await task()
      } finally {
        clearOperation(operation)
      }
    })
  }

  noteCompactionId(compactionId: string): void {
    const operation = this.storage.getStore()
    if (operation !== undefined) operation.compactionId = compactionId
  }

  noteStrictShrink(model: string): void {
    const operation = this.storage.getStore()
    if (operation === undefined) return
    operation.continuation = undefined
    emitDiagnostic(operation, model, {
      event: 'fallback',
      breakerState: 'closed',
      reason: 'strict-shrink',
    })
  }

  noteResult(
    model: string,
    result: Extract<NativeCompactionDiagnosticDetail, { event: 'result' }>['result'],
  ): void {
    const operation = this.storage.getStore()
    if (operation !== undefined) emitDiagnostic(operation, model, { event: 'result', result })
  }

  /** Capture the one inherited Portable call made inside the active Basic operation. */
  async withPortableCapture<T>(
    input: readonly Message[],
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const operation = this.storage.getStore()
    if (operation === undefined) return task()
    operation.continuation = undefined
    if (operation.phase !== undefined) {
      throw new Error('codex native compaction: nested Portable summarization is unsupported')
    }
    const phase: PortablePhase = {
      input,
      signal,
      credential: undefined,
      providerRequest: undefined,
      instructionText: undefined,
      payload: undefined,
    }
    operation.phase = phase
    try {
      return await task()
    } finally {
      if (operation.phase === phase) operation.phase = undefined
      clearPhase(phase)
    }
  }

  /** Capture Basic's actual appended instruction without copying its private text. */
  notePortableCall(options: GenerateOptions): void {
    const phase = this.storage.getStore()?.phase
    if (phase === undefined
      || options.purpose !== 'compaction'
      || options.messages.length !== phase.input.length + 1
      || !phase.input.every((message, index) =>
        isDeepStrictEqual(message, options.messages[index]))) return
    const finalMessage = options.messages.at(-1)
    const finalBlock = finalMessage?.content[0]
    if (finalMessage?.role !== 'user'
      || finalMessage.content.length !== 1
      || finalBlock?.type !== 'text'
      || finalBlock.text.length === 0) return
    phase.instructionText = finalBlock.text
  }

  /** Retain the already resolved Codex Login State only for this request scope. */
  noteCredential(accessToken: string, accountId: string | undefined): void {
    const phase = this.storage.getStore()?.phase
    if (phase === undefined) return
    phase.credential = {
      accessToken,
      ...(accountId === undefined ? {} : { accountId }),
    }
  }

  /** Retain public provider routing inputs and the existing transport policy in memory. */
  noteProviderRequest(input: ProviderRequestInput): void {
    const phase = this.storage.getStore()?.phase
    const adapterGeneration = codexTurnStateContinuity.currentGeneration()
    if (phase === undefined || adapterGeneration === undefined) return
    phase.providerRequest = {
      provider: input.provider,
      model: input.model,
      adapterGeneration,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      publicHeaders: capturePublicHeaders(input.modelHeaders, input.headers),
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      streamIdleTimeoutMs: input.streamIdleTimeoutMs,
    }
  }

  /** Compose final payload capture after marker restoration and all existing callbacks. */
  payloadCallback(previous?: PayloadCallback): PayloadCallback | undefined {
    const operation = this.storage.getStore()
    const phase = operation?.phase
    if (operation === undefined || phase === undefined) return previous
    return async (payload, model) => {
      const returned = await previous?.(payload, model)
      const effective = returned === undefined ? payload : returned
      const wirePayload = normalizeWirePayload(effective)
      if (wirePayload === undefined) {
        throw new Error('codex native compaction: final Portable payload is not lossless JSON')
      }
      phase.payload = wirePayload
      return effective
    }
  }

  /**
   * After Portable success, make at most one dedicated v2 request and return a
   * credential-free block. Every ordinary native failure is a Portable fallback.
   */
  async createCheckpoint(
    input: readonly Message[],
    portableProvider: string,
    portableModel: string,
    signal?: AbortSignal,
  ): Promise<CodexNativeCheckpointBlock | undefined> {
    const operation = this.storage.getStore()
    const phase = operation?.phase
    if (operation === undefined || phase === undefined || phase.input !== input) return undefined
    const operationSignal = signal ?? phase.signal ?? operation.callerSignal
    operationSignal.throwIfAborted()
    let lease: NativeCompactionBreakerLease | undefined
    let startedAt: number | undefined
    try {
      const eligible = eligibleCapture(operation, phase, portableProvider, portableModel)
      if (eligible === undefined) {
        emitDiagnostic(operation, portableModel, {
          event: 'eligibility',
          eligibility: 'ineligible',
        })
        return undefined
      }
      emitDiagnostic(operation, portableModel, {
        event: 'eligibility',
        eligibility: 'eligible',
      })
      const nativeRequest = deriveNativeRequest(
        eligible.payload,
        portableModel,
        eligible.instructionText,
      )
      if (nativeRequest === undefined) {
        emitDiagnostic(operation, portableModel, {
          event: 'fallback',
          breakerState: 'not-acquired',
          reason: 'unsupported-payload',
        })
        return undefined
      }
      const accountHash = hashCodexAccountIdentity(eligible.credential.accountId)
      lease = nativeCompactionBreaker.acquire(nativeCompactionBreakerKey(
        accountHash,
        portableModel,
        codexResponsesUrl(eligible.providerRequest.baseUrl),
      ))
      if (lease === undefined) {
        emitDiagnostic(operation, portableModel, {
          event: 'fallback',
          breakerState: 'open',
          reason: 'circuit-open',
        })
        return undefined
      }
      emitDiagnostic(operation, portableModel, {
        event: 'attempt',
        breakerState: lease.state,
        requestBytes: serializedJsonBytes(nativeRequest.body),
      })
      startedAt = performance.now()
      const response = await sendCodexNativeCompaction(
        eligible.providerRequest,
        eligible.credential,
        operation,
        nativeRequest.body,
        operationSignal,
      )
      operationSignal.throwIfAborted()
      const opaqueContent = response.artifact.encrypted_content
      if (typeof opaqueContent !== 'string') throw new NativeCompactionFailure('protocol')
      emitDiagnostic(operation, portableModel, {
        event: 'response',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outputItems: response.ignoredOutputItems + 1,
        ignoredOutputItems: response.ignoredOutputItems,
        artifactBytes: serializedJsonBytes(response.artifact),
        opaqueBytes: utf8ByteLength(opaqueContent),
        usage: response.usage ?? { source: 'unavailable' },
      })
      const retained = retainRecentCodexUserMessages(
        nativeRequest.body.input as JsonValue[],
        CODEX_NATIVE_RETENTION_TOKEN_BUDGET,
      )
      const replacementItems = [
        ...retained,
        response.artifact,
      ] satisfies CodexResponsesItem[]
      const checkpoint: CodexNativeCheckpointV1 = {
        schemaVersion: CODEX_NATIVE_CHECKPOINT_SCHEMA_VERSION,
        codec: {
          kind: CODEX_NATIVE_CHECKPOINT_CODEC,
          generation: CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
        },
        retention: {
          policy: CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY,
          generation: CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION,
        },
        provenance: {
          provider: CODEX_ROUTE,
          model: portableModel,
          accountHash,
        },
        compatibilityDigest: codexNativeCheckpointCompatibilityDigest({
          provider: CODEX_ROUTE,
          model: portableModel,
          accountHash,
          instructions: nativeRequest.semanticInput.instructions,
          tools: nativeRequest.semanticInput.tools,
          parallelToolCalls: nativeRequest.semanticInput.parallelToolCalls,
          toolChoice: nativeRequest.semanticInput.toolChoice,
          reasoning: nativeRequest.semanticInput.reasoning,
          text: nativeRequest.semanticInput.text,
          serviceTier: nativeRequest.semanticInput.serviceTier,
        }),
        replay: {
          estimator: CODEX_NATIVE_CHECKPOINT_ESTIMATOR,
          estimatedTokens: estimateCodexJsonTokens(replacementItems),
        },
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        replacementItems,
      }
      const checkpointBytes = serializedJsonBytes({
        type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
        text: '',
        state: JSON.stringify(checkpoint),
      })
      if (checkpointBytes > MAX_CODEX_NATIVE_CHECKPOINT_BYTES) {
        lease.ignore()
        emitDiagnostic(operation, portableModel, {
          event: 'fallback',
          breakerState: lease.state,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          reason: 'size',
        })
        return undefined
      }
      const block = encodeCodexNativeCheckpoint(checkpoint)
      emitDiagnostic(operation, portableModel, {
        event: 'candidate',
        checkpointBytes,
        replayTokens: checkpoint.replay.estimatedTokens,
      })
      lease.succeed()
      if (operation.inline
        && operation.trigger !== 'manual'
        && response.turnState !== undefined) {
        operation.continuation = {
          sessionId: operation.sessionId,
          provider: CODEX_ROUTE,
          model: portableModel,
          accountHash,
          generation: eligible.providerRequest.adapterGeneration,
          turnState: response.turnState,
        }
      }
      return block
    } catch (error) {
      operationSignal.throwIfAborted()
      const failure = error instanceof NativeCompactionFailure
        ? error
        : new NativeCompactionFailure('protocol')
      if (failure.kind === 'size') {
        lease?.ignore()
        emitDiagnostic(operation, portableModel, {
          event: 'fallback',
          breakerState: lease?.state ?? 'not-acquired',
          ...(startedAt === undefined
            ? {}
            : { durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }),
          reason: 'size',
        })
        return undefined
      }
      const breakerState = lease?.fail(failure) ?? 'not-acquired'
      emitDiagnostic(operation, portableModel, {
        event: 'fallback',
        breakerState,
        ...(startedAt === undefined
          ? {}
          : { durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }),
        reason: failure.kind,
      })
      return undefined
    }
  }
}

function eligibleCapture(
  operation: CompactionOperation,
  phase: PortablePhase,
  portableProvider: string,
  portableModel: string,
): {
  readonly credential: CapturedCredential & { readonly accountId: string }
  readonly providerRequest: CapturedProviderRequest
  readonly instructionText: string
  readonly payload: Record<string, JsonValue>
} | undefined {
  const target = operation.target
  const credential = phase.credential
  const request = phase.providerRequest
  const instructionText = phase.instructionText
  const payload = phase.payload
  if (target?.provider !== CODEX_ROUTE
    || target.model !== portableModel
    || portableProvider !== CODEX_ROUTE
    || phase.input.length === 0
    || messagesHaveImages(phase.input)
    || credential === undefined
    || typeof credential.accountId !== 'string'
    || credential.accountId.length === 0
    || credential.accessToken.length === 0
    || request?.provider !== CODEX_ROUTE
    || request.model !== portableModel
    || request.sessionId !== operation.sessionId
    || instructionText === undefined
    || payload === undefined) return undefined
  return {
    credential: { accessToken: credential.accessToken, accountId: credential.accountId },
    providerRequest: request,
    instructionText,
    payload,
  }
}

function deriveNativeRequest(
  captured: Record<string, JsonValue>,
  expectedModel: string,
  instructionText: string,
): NativeRequest | undefined {
  if (captured.model !== expectedModel
    || typeof captured.instructions !== 'string'
    || !Array.isArray(captured.input)
    || captured.input.length < 2
    || typeof captured.parallel_tool_calls !== 'boolean'
    || captured.tool_choice !== 'auto'
    || (captured.tools !== undefined && !Array.isArray(captured.tools))
    || (captured.reasoning !== undefined && !isPlainRecord(captured.reasoning))
    || (captured.text !== undefined && !isPlainRecord(captured.text))
    || (captured.service_tier !== undefined && typeof captured.service_tier !== 'string')
    || (captured.prompt_cache_key !== undefined && typeof captured.prompt_cache_key !== 'string')) {
    return undefined
  }
  const input = captured.input.map(cloneJson)
  const finalItem = input.pop()
  if (!isCapturedCompactionInstruction(finalItem, instructionText)
    || input.length === 0
    || wireInputHasImage(input)) {
    return undefined
  }
  const tools = captured.tools === undefined ? null : cloneJson(captured.tools)
  const reasoning = captured.reasoning === undefined ? null : cloneJson(captured.reasoning)
  const text = captured.text === undefined ? null : cloneJson(captured.text)
  const serviceTier = captured.service_tier ?? null
  const body: Record<string, JsonValue> = {
    model: expectedModel,
    input: [...input, { type: 'compaction_trigger' }],
    instructions: captured.instructions,
    ...(captured.tools === undefined ? {} : { tools }),
    parallel_tool_calls: captured.parallel_tool_calls,
    tool_choice: 'auto',
    ...(captured.reasoning === undefined ? {} : { reasoning }),
    ...(captured.text === undefined ? {} : { text }),
    ...(captured.service_tier === undefined ? {} : { service_tier: serviceTier }),
    ...(captured.prompt_cache_key === undefined
      ? {}
      : { prompt_cache_key: captured.prompt_cache_key }),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  return {
    body,
    semanticInput: {
      instructions: captured.instructions,
      tools,
      parallelToolCalls: captured.parallel_tool_calls,
      toolChoice: 'auto',
      reasoning,
      text,
      serviceTier,
    },
  }
}

function isCapturedCompactionInstruction(
  value: JsonValue | undefined,
  instructionText: string,
): boolean {
  return isPlainRecord(value)
    && value.role === 'user'
    && Object.keys(value).every(key => key === 'role' || key === 'content')
    && Array.isArray(value.content)
    && value.content.length === 1
    && isPlainRecord(value.content[0])
    && Object.keys(value.content[0]).every(key => key === 'type' || key === 'text')
    && value.content[0].type === 'input_text'
    && value.content[0].text === instructionText
}

function messagesHaveImages(messages: readonly Message[]): boolean {
  return messages.some(message => message.content.some(block => block.type === 'image'))
}

function wireInputHasImage(input: readonly JsonValue[]): boolean {
  return input.some(item => containsType(item, 'input_image'))
}

function containsType(value: JsonValue, type: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsType(item, type))
  if (!isPlainRecord(value)) return false
  const record = value as Record<string, JsonValue>
  return record.type === type || Object.values(record).some(item => containsType(item, type))
}

function capturePublicHeaders(
  modelHeaders?: Readonly<Record<string, string>>,
  requestHeaders?: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  const source = new Headers(modelHeaders)
  for (const [name, value] of Object.entries(requestHeaders ?? {})) {
    if (value === null) source.delete(name)
    else source.set(name, value)
  }
  const captured: Record<string, string> = {}
  for (const name of ['openai-beta', 'x-codex-beta-features']) {
    const value = source.get(name)
    if (value !== null) captured[name] = value
  }
  return Object.freeze(captured)
}

function cloneJson<Value>(value: Value): Value {
  return structuredClone(value)
}

function normalizeWirePayload(value: unknown): Record<string, JsonValue> | undefined {
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(value))
    if (!isPlainJsonTree(normalized) || !isPlainRecord(normalized)) return undefined
    return normalized as Record<string, JsonValue>
  } catch {
    return undefined
  }
}

function emitDiagnostic(
  operation: CompactionOperation,
  model: string,
  detail: NativeCompactionDiagnosticDetail,
): void {
  try {
    operation.diagnostic({
      codec: CODEX_NATIVE_CHECKPOINT_CODEC,
      codecGeneration: CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
      compactionId: operation.compactionId ?? 'unavailable',
      model,
      trigger: operation.trigger,
      ...detail,
    } as CodexNativeCompactionDiagnostic)
  } catch {
    // Observability must never change Portable fallback or cancellation semantics.
  }
}

function clearPhase(phase: PortablePhase): void {
  phase.credential = undefined
  phase.providerRequest = undefined
  phase.instructionText = undefined
  phase.payload = undefined
}

function clearOperation(operation: CompactionOperation): void {
  if (operation.phase !== undefined) clearPhase(operation.phase)
  operation.compactionId = undefined
  operation.continuation = undefined
  operation.phase = undefined
}

export const codexNativeCompactionCoordinator = new CodexNativeCompactionCoordinator()
