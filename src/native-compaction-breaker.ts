import {
  CODEX_NATIVE_CHECKPOINT_CODEC,
  CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
} from './native-checkpoint.ts'

const TRANSIENT_FAILURE_WINDOW_MS = 5 * 60 * 1000
const TRANSIENT_OPEN_MS = 10 * 60 * 1000
const PROTOCOL_OPEN_MS = 60 * 60 * 1000
const MAX_RATE_LIMIT_OPEN_MS = 60 * 60 * 1000
export const CODEX_NATIVE_DEFAULT_RATE_LIMIT_OPEN_MS = 60 * 1000

type NativeFailureKind = 'auth' | 'protocol' | 'rate-limit' | 'size' | 'transient'

export class NativeCompactionFailure extends Error {
  constructor(
    readonly kind: NativeFailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(`Codex native compaction ${kind} failure`)
  }
}

interface BreakerState {
  readonly transientFailures: number[]
  openUntil: number
  halfOpenProbe: boolean
  inFlight: number
}

export interface NativeCompactionBreakerLease {
  readonly state: 'closed' | 'half-open'
  succeed(): void
  fail(failure: NativeCompactionFailure): 'closed' | 'open'
  ignore(): void
}

/** Process-local failure gate; it never retries or affects Portable operations. */
class NativeCompactionBreaker {
  private readonly states = new Map<string, BreakerState>()

  acquire(key: string, now = Date.now()): NativeCompactionBreakerLease | undefined {
    this.pruneStaleTransientStates(now)
    let state = this.states.get(key)
    if (state === undefined) {
      state = { transientFailures: [], openUntil: 0, halfOpenProbe: false, inFlight: 0 }
      this.states.set(key, state)
    }
    if (state.openUntil > now || state.halfOpenProbe) return undefined
    const halfOpen = state.openUntil > 0
    if (halfOpen) state.halfOpenProbe = true
    const activeState = state
    activeState.inFlight += 1
    let settled = false
    return {
      state: halfOpen ? 'half-open' : 'closed',
      succeed: () => {
        if (settled) return
        settled = true
        activeState.inFlight -= 1
        activeState.openUntil = 0
        activeState.halfOpenProbe = false
        activeState.transientFailures.length = 0
        if (activeState.inFlight === 0 && this.states.get(key) === activeState) {
          this.states.delete(key)
        }
      },
      fail: (failure) => {
        if (!settled) {
          settled = true
          activeState.inFlight -= 1
          this.recordFailure(key, activeState, failure, halfOpen, Date.now())
        }
        return activeState.openUntil > Date.now() ? 'open' : 'closed'
      },
      ignore: () => {
        if (settled) return
        settled = true
        activeState.inFlight -= 1
        this.releaseIgnoredState(key, activeState)
      },
    }
  }

  private releaseIgnoredState(key: string, state: BreakerState): void {
    state.halfOpenProbe = false
    if (state.inFlight === 0
      && state.openUntil === 0
      && state.transientFailures.length === 0
      && this.states.get(key) === state) this.states.delete(key)
  }

  private pruneStaleTransientStates(now: number): void {
    for (const [key, state] of this.states) {
      if (state.inFlight === 0
        && state.openUntil === 0
        && !state.halfOpenProbe
        && state.transientFailures.length > 0
        && state.transientFailures.every(
          timestamp => now - timestamp > TRANSIENT_FAILURE_WINDOW_MS,
        )) this.states.delete(key)
    }
  }

  private recordFailure(
    key: string,
    state: BreakerState,
    failure: NativeCompactionFailure,
    halfOpen: boolean,
    now: number,
  ): void {
    state.halfOpenProbe = false
    if (failure.kind === 'size') {
      this.releaseIgnoredState(key, state)
      return
    }
    if (failure.kind === 'auth') {
      if (state.inFlight === 0
        && (halfOpen || state.transientFailures.length === 0)
        && this.states.get(key) === state) this.states.delete(key)
      return
    }
    if (failure.kind === 'rate-limit') {
      const requested = failure.retryAfterMs ?? CODEX_NATIVE_DEFAULT_RATE_LIMIT_OPEN_MS
      state.openUntil = now + Math.min(Math.max(0, requested), MAX_RATE_LIMIT_OPEN_MS)
      state.transientFailures.length = 0
      return
    }
    if (failure.kind === 'protocol') {
      state.openUntil = now + PROTOCOL_OPEN_MS
      state.transientFailures.length = 0
      return
    }
    const recent = state.transientFailures.filter(
      timestamp => now - timestamp <= TRANSIENT_FAILURE_WINDOW_MS,
    )
    state.transientFailures.splice(0, state.transientFailures.length, ...recent, now)
    if (halfOpen || state.transientFailures.length >= 3) {
      state.openUntil = now + TRANSIENT_OPEN_MS
      state.transientFailures.length = 0
    }
  }
}

export function nativeCompactionBreakerKey(
  accountHash: string,
  model: string,
  endpoint: string,
): string {
  return JSON.stringify([
    accountHash,
    model,
    endpoint,
    CODEX_NATIVE_CHECKPOINT_CODEC,
    CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
  ])
}

export const nativeCompactionBreaker = new NativeCompactionBreaker()
