import { AsyncLocalStorage } from 'node:async_hooks'
import type { StreamOptions } from '@earendil-works/pi-ai'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { hashCodexAccountIdentity } from './native-checkpoint.ts'

const CODEX_ROUTE = 'openai-codex'
const TURN_STATE_HEADER = 'x-codex-turn-state'

/** Provider-confirmed continuation lifetime from the issue contract. */
export const CODEX_TURN_STATE_TTL_MS = 60_000

/** One immutable prepared-Adapter generation with mutable retirement state. */
export class CodexAdapterGeneration {
  active = true
}

/** Identity captured from the original loop-owned request at the LLM waterfall. */
interface LoopRequestScope {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly candidate?: PendingContinuation
  accountHash: string | undefined
  settled: boolean
}

/** Secret-bearing process-local state; no member crosses a durable or diagnostic boundary. */
interface PendingContinuation {
  readonly sessionId: string
  readonly provider: typeof CODEX_ROUTE
  readonly model: string
  readonly accountHash: string
  readonly generation: CodexAdapterGeneration
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  turnState: string
}

export interface CodexTurnStateContinuationInput {
  readonly sessionId: string
  readonly provider: typeof CODEX_ROUTE
  readonly model: string
  readonly accountHash: string
  readonly generation: CodexAdapterGeneration
  readonly turnState: string
}

/**
 * Host-only one-shot handoff from inline native compaction to one loop request.
 * The original GenerateOptions identity is observed before LlmRuntime projects
 * or clones it; adapter code consumes only this request scope.
 */
class CodexTurnStateContinuity {
  private readonly requestStorage = new AsyncLocalStorage<LoopRequestScope>()
  private readonly generationStorage = new AsyncLocalStorage<CodexAdapterGeneration>()
  private readonly pendingBySession = new Map<string, PendingContinuation>()

  createGeneration(): CodexAdapterGeneration {
    return new CodexAdapterGeneration()
  }

  /** Retire a route snapshot and synchronously erase every continuation it owns. */
  retireGeneration(generation: CodexAdapterGeneration): void {
    if (!generation.active) return
    generation.active = false
    for (const pending of this.pendingBySession.values()) {
      if (pending.generation === generation) this.discard(pending)
    }
  }

  /**
   * Read the exact waterfall request, call next() without projecting or replacing
   * it, and keep the resulting identity around every lazy iterator advancement.
   */
  observeLlmStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    const sessionId = String(options.sessionId)
    let candidate = this.pendingBySession.get(sessionId)
    if (candidate !== undefined && (
      this.expired(candidate)
      || candidate.provider !== options.provider
      || candidate.model !== options.model
    )) {
      this.discard(candidate)
      candidate = undefined
    }
    const scope: LoopRequestScope = {
      sessionId,
      provider: options.provider,
      model: options.model,
      ...(candidate === undefined ? {} : { candidate }),
      accountHash: undefined,
      settled: false,
    }
    return this.scopedStream(this.requestStorage, scope, next, () => {
      try {
        if (!scope.settled && scope.candidate !== undefined) this.discard(scope.candidate)
      } finally {
        scope.accountHash = undefined
        scope.settled = true
      }
    })
  }

  /** Bind one prepared Adapter generation around its lazy provider dispatch. */
  withAdapterGeneration<T>(
    generation: CodexAdapterGeneration,
    dispatch: () => AsyncIterable<T>,
  ): AsyncIterable<T> {
    return this.scopedStream(this.generationStorage, generation, dispatch)
  }

  currentGeneration(): CodexAdapterGeneration | undefined {
    return this.generationStorage.getStore()
  }

  /** Record only a domain-separated account hash in the loop request scope. */
  noteAccount(accountId: string | undefined): void {
    const scope = this.requestStorage.getStore()
    if (scope === undefined) return
    scope.accountHash = accountId === undefined
      ? undefined
      : hashCodexAccountIdentity(accountId)
  }

  /**
   * Consume a matching continuation immediately before the provider stream is
   * created. Any account/generation/request mismatch erases it without sending.
   */
  applyProviderOptions<Options extends StreamOptions | undefined>(
    options: Options,
    provider: string,
    model: string,
  ): Options {
    const scope = this.requestStorage.getStore()
    const generation = this.generationStorage.getStore()
    const candidate = scope?.candidate
    if (scope === undefined || candidate === undefined || scope.settled) return options
    const sessionId = options?.sessionId
    const matches = this.pendingBySession.get(scope.sessionId) === candidate
      && candidate.turnState.length > 0
      && !this.expired(candidate)
      && generation !== undefined
      && generation.active
      && candidate.generation === generation
      && scope.provider === provider
      && scope.model === model
      && sessionId === scope.sessionId
      && scope.accountHash !== undefined
      && candidate.accountHash === scope.accountHash
    if (!matches) {
      this.discard(candidate)
      scope.settled = true
      return options
    }
    const turnState = candidate.turnState
    this.discard(candidate)
    scope.settled = true
    return {
      ...options,
      headers: {
        ...options?.headers,
        [TURN_STATE_HEADER]: turnState,
      },
    } as unknown as Options
  }

  /** Arm only after Basic reports the inline Dual Checkpoint commit as successful. */
  arm(input: CodexTurnStateContinuationInput): void {
    if (!input.generation.active || input.turnState.length === 0) return
    const previous = this.pendingBySession.get(input.sessionId)
    if (previous !== undefined) this.discard(previous)
    const expiresAt = Date.now() + CODEX_TURN_STATE_TTL_MS
    let pending!: PendingContinuation
    const timer = setTimeout(() => this.discard(pending), CODEX_TURN_STATE_TTL_MS)
    timer.unref()
    pending = {
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      accountHash: input.accountHash,
      generation: input.generation,
      expiresAt,
      timer,
      turnState: input.turnState,
    }
    this.pendingBySession.set(input.sessionId, pending)
  }

  private expired(pending: PendingContinuation): boolean {
    return Date.now() >= pending.expiresAt
  }

  private discard(pending: PendingContinuation): void {
    clearTimeout(pending.timer)
    if (this.pendingBySession.get(pending.sessionId) === pending) {
      this.pendingBySession.delete(pending.sessionId)
    }
    pending.turnState = ''
  }

  private async * scopedStream<Scope, Value>(
    storage: AsyncLocalStorage<Scope>,
    scope: Scope,
    dispatch: () => AsyncIterable<Value>,
    cleanup?: () => void,
  ): AsyncIterable<Value> {
    let iterator: AsyncIterator<Value> | undefined
    try {
      iterator = storage.run(scope, () => dispatch()[Symbol.asyncIterator]())
      while (true) {
        const result = await storage.run(scope, () => iterator!.next())
        if (result.done === true) return
        yield result.value
      }
    } finally {
      cleanup?.()
      if (iterator?.return !== undefined) {
        await storage.run(scope, () => iterator!.return!())
      }
    }
  }
}

export const codexTurnStateContinuity = new CodexTurnStateContinuity()
