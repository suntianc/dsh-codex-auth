/**
 * The `codexAuth` service: login status and login-flow startup for the web
 * surface. Status is value-free (no token material ever leaves this service),
 * and login only spawns the official codex CLI, which owns the whole flow —
 * browser PKCE by default, device-code on request.
 *
 * Authenticated operations resolve credentials through an in-memory cache
 * that is validated per call with a single stat: a fresh token with an
 * untouched auth file is served without any file read or cross-process lock.
 * Refresh happens proactively in the background (ahead of expiry and of the
 * codex CLI's 8-day refresh age), so the request path only refreshes
 * synchronously when a token is genuinely needed — after long process-down
 * idle, or when a refresh failed and the token is still required.
 *
 * @module dsh-codex-auth/codex-auth-service
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  authState, decodeAccessToken, DEFAULT_REFRESH_LEAD_MS, MAX_REFRESH_AGE_MS, mergeRefreshed,
  needsRefresh, readAuthFile, readAuthFileVersion, readAuthSnapshot, refreshTokens, refreshTooOld,
  sameAuthFileVersion, writeAuthFile,
} from './codex-auth.ts'
import type {
  CodexAuthFile, CodexAuthFileVersion, CodexAuthSnapshot, CodexRefreshReply,
} from './codex-auth.ts'
import { readBoundedResponseText } from './bounded-response.ts'
import type { CodexAuthLoginMode, CodexAuthStatusView, CodexUsageView } from './rpc-contract.ts'
export type { CodexAuthLoginMode, CodexAuthStatusView, CodexUsageView } from './rpc-contract.ts'

/** Options one service instance is constructed with. */
export interface CodexAuthServiceOptions {
  /** The codex auth file path (`~/.codex/auth.json` by default). */
  authJsonPath: string
  /** The codex CLI command to spawn for login and version probing. */
  codexCommand: string
  /** The value-free CredentialRef advertised by status surfaces. */
  credentialRef: CredentialRef
  /** Lead time before access-token expiry that triggers refresh. */
  refreshLeadMs?: number
  /** Injectable refresh transport; defaults to the Host's fetch. */
  fetchImpl?: typeof fetch
  /** Host-owned deadline for the best-effort usage probe; primarily injectable for tests. */
  usageTimeoutMs?: number
  /** Maximum teardown wait for abortable auth work; atomic commits always drain. */
  disposeTimeoutMs?: number
  /** Injectable atomic auth-file writer; defaults to the production writer. */
  authFileWriter?: (path: string, file: CodexAuthFile) => Promise<void>
  /** Injectable process spawner for CLI lifecycle tests. */
  spawnImpl?: typeof spawn
  /** Grace period before a stuck CLI probe is force-stopped. */
  probeStopTimeoutMs?: number
}

/** Host-only credential facts returned at an authenticated operation boundary. */
export interface CodexCredential {
  accessToken: string
  accountId?: string
  /** Locally decoded plan claim; absence means unknown, not unavailable. */
  planType?: string
}

/** How long a resolved credential may be served from memory without re-reading the auth file. */
const CREDENTIAL_CACHE_MAX_AGE_MS = 10 * 60 * 1000

/** How long a computed status may be served without re-reading the auth file. */
const STATUS_CACHE_TTL_MS = 2_000

/** Lead before a refresh threshold at which the background refresh timer fires. */
const REFRESH_GRACE_MS = 60 * 1000

/** Retry interval after a failed background refresh. */
const BACKGROUND_REFRESH_RETRY_MS = 5 * 60 * 1000

/** Maximum unload wait after signalling cancellation to abortable auth work. */
const DISPOSE_TIMEOUT_MS = 5_000

/** Floor for a background refresh that is not yet due; avoids a zero-delay re-arm loop. */
const BACKGROUND_REFRESH_MIN_DELAY_MS = 60 * 1000

/** Ceiling for one setTimeout delay (Node's 32-bit signed millisecond cap). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Codex CLI version probe timeout. */
const PROBE_TIMEOUT_MS = 5_000

/** Grace before a stopping CLI probe is detached and force-killed. */
const PROBE_STOP_TIMEOUT_MS = 500

/** Read-only ChatGPT backend endpoint answering the account's usage windows. */
const CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

/** Hard cap for the usage envelope; the real payload is a few hundred bytes. */
const CODEX_USAGE_MAX_BYTES = 64 * 1024

/** Host-owned deadline so a stalled private endpoint cannot pin the RPC forever. */
const CODEX_USAGE_TIMEOUT_MS = 10_000

/** Codex's subscription window is identified by duration, not primary/secondary position. */
const WEEKLY_USAGE_WINDOW_SECONDS = 7 * 24 * 60 * 60

/** One resolved credential plus the facts that decide whether it may be served again. */
interface CachedCredential {
  credential: CodexCredential
  /** The access token's expiry in epoch milliseconds, when decodable. */
  accessTokenExpiresAt: number | undefined
  /** When this entry was resolved. */
  cachedAt: number
  /** Exact version of the auth-file inode whose bytes produced this credential. */
  fileVersion: CodexAuthFileVersion
}

/**
 * The codexAuth service. Constructing it registers it as `codexAuth`; this
 * package's dedicated Connection RPC channel is its only browser transport.
 */
export class CodexAuthService extends Service {
  private codexVersion: string | undefined
  private lastStatus: CodexAuthStatusView | undefined
  private readonly statusListeners = new Set<() => void>()
  private cachedCredential: CachedCredential | undefined
  private refreshTimer: NodeJS.Timeout | undefined
  private credentialFlight: Promise<CodexCredential | undefined> | undefined
  private backgroundRefreshFlight: Promise<void> | undefined
  private readonly commitFlights = new Set<Promise<void>>()
  private readonly lifecycleAbort = new AbortController()
  private disposed = false
  private statusReadAt = 0

  constructor(ctx: Context, private readonly options: CodexAuthServiceOptions) {
    super(ctx, 'codexAuth')
    this.probeCodex()
    this.ctx.effect(() => () => this.disposeOperations(), 'codex-auth: operations')
  }

  private async disposeOperations(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearRefreshTimer()
    this.statusListeners.clear()
    this.cachedCredential = undefined
    this.lifecycleAbort.abort(new Error('codex-auth: auth operation cancelled during disposal'))

    const foreground = this.credentialFlight
    const background = this.backgroundRefreshFlight
    const operations = [
      ...(foreground === undefined ? [] : [foreground]),
      ...(background === undefined ? [] : [background]),
    ]
    if (operations.length > 0) {
      const timeoutMs = this.options.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS
      const drain = Promise.allSettled(operations).then(() => {})
      if (!await waitForSettlement(drain, timeoutMs)) {
        this.ctx.logger.warn(
          'codex-auth: abortable auth work did not stop within %dms; disposal will continue',
          timeoutMs,
        )
      }
    }
    this.credentialFlight = undefined

    // Once an atomic commit starts it is not cancellable. Keep teardown joined
    // to it so no auth-file mutation can finish after the module is disposed.
    if (this.commitFlights.size > 0) await Promise.allSettled(this.commitFlights)
  }

  /** Whether the codex CLI resolved at startup. */
  get available(): boolean {
    return this.codexVersion !== undefined
  }

  /** Last locally observed value-free status, when one has been read. */
  get cachedStatus(): CodexAuthStatusView | undefined {
    return this.lastStatus
  }

  /** Observe locally verified status changes without exposing credentials. */
  watchStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /**
   * Resolve credentials for one authenticated operation. A fresh cached
   * credential with an untouched auth file is served directly (one stat, no
   * read, no lock); everything else shares one in-process flight, which
   * re-reads under the cross-process writer lock before deciding whether to
   * refresh.
   */
  async credential(signal?: AbortSignal): Promise<CodexCredential | undefined> {
    throwIfAborted(signal)
    if (this.disposed) return undefined
    const cached = this.cachedCredential
    if (cached !== undefined) {
      const fresh = await this.cachedCredentialFresh(cached)
      if (this.disposed) return undefined
      if (fresh) return cached.credential
    }
    let flight = this.credentialFlight
    if (flight === undefined) {
      flight = this.resolveCredential(this.lifecycleAbort.signal).finally(() => {
        if (this.credentialFlight === flight) this.credentialFlight = undefined
      })
      this.credentialFlight = flight
    }
    return waitForCredential(flight, signal, this.lifecycleAbort.signal)
  }

  /**
   * Whether a cached credential may still be served: the token must remain
   * comfortably valid, the entry must be younger than the cache ceiling, and
   * the auth file must not have changed under it (a `codex login` re-run or
   * another process's refresh). The file check is one stat — no read, no lock.
   */
  private async cachedCredentialFresh(cached: CachedCredential): Promise<boolean> {
    const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
    if (cached.accessTokenExpiresAt !== undefined && cached.accessTokenExpiresAt - Date.now() < leadMs) {
      return false
    }
    if (Date.now() - cached.cachedAt >= CREDENTIAL_CACHE_MAX_AGE_MS) return false
    try {
      const current = await readAuthFileVersion(this.options.authJsonPath)
      return current !== undefined && sameAuthFileVersion(current, cached.fileVersion)
    } catch {
      return false
    }
  }

  /** Describe the current login state without exposing any token material. */
  async status(): Promise<CodexAuthStatusView> {
    if (this.lastStatus !== undefined && Date.now() - this.statusReadAt < STATUS_CACHE_TTL_MS) {
      return this.lastStatus
    }
    let file: CodexAuthFile | undefined
    try {
      file = await readAuthFile(this.options.authJsonPath)
    } catch (error) {
      if (!this.disposed) this.warnCredentialFailure('status could not read the Codex Login State', error)
    }
    const status = statusFromFile(file, this.available, this.codexVersion, this.options.credentialRef)
    if (this.disposed) return status
    this.statusReadAt = Date.now()
    return this.publishStatus(status)
  }

  /**
   * Read-only weekly usage snapshot for the settings login block. The ChatGPT
   * backend's `/wham/usage` endpoint answers multiple account windows; the
   * seven-day window is selected by duration rather than field position. The
   * probe never throws: a failure answers an empty view, which the settings
   * card renders as dashes instead of erroring the whole login block.
   */
  async usage(signal?: AbortSignal): Promise<CodexUsageView> {
    const bounded = boundedSignal(
      [signal, this.lifecycleAbort.signal],
      this.options.usageTimeoutMs ?? CODEX_USAGE_TIMEOUT_MS,
    )
    try {
      throwIfAborted(bounded.signal)
      const credential = await this.credential(bounded.signal)
      if (credential === undefined) return {}
      return await waitForAbort(
        probeUsage(this.options.fetchImpl ?? fetch, credential, bounded.signal),
        bounded.signal,
      )
    } catch {
      // Best-effort probe: login problems, network failures, malformed
      // envelopes, and cancellation all degrade to an empty view.
      return {}
    } finally {
      bounded.cleanup()
    }
  }

  /** Start the official codex login flow in the background. */
  login(mode: CodexAuthLoginMode): Promise<{ started: boolean }> {
    if (!this.available) {
      return Promise.reject(new Error(
        `codex-auth: the codex CLI ("${this.options.codexCommand}") is not on PATH; `
        + 'install it (or adjust the plugin\'s codexCommand config) before logging in',
      ))
    }
    const args = mode === 'device' ? ['login', '--device-auth'] : ['login']
    try {
      const child = (this.options.spawnImpl ?? spawn)(this.options.codexCommand, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return Promise.resolve({ started: true })
    } catch (error) {
      return Promise.reject(new Error(
        `codex-auth: failed to start ${this.options.codexCommand} login: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }

  /** Resolve from the latest locked document and refresh at most once. */
  private async resolveCredential(signal: AbortSignal): Promise<CodexCredential | undefined> {
    let observed: CodexAuthFile | undefined
    try {
      observed = await readAuthFile(this.options.authJsonPath)
      if (isAborted(signal)) return undefined
    } catch (error) {
      if (isAborted(signal)) return undefined
      // The pre-lock read is only a hint: another DSH process or Codex CLI may
      // replace a missing or malformed document before this process owns the lock.
      this.warnCredentialFailure('pre-lock read could not inspect the Codex Login State', error)
    }

    try {
      // Phase 1 — decide under the writer lock whether a refresh is due. The
      // OAuth round trip happens OUTSIDE the lock (phase 2), so a slow token
      // endpoint never blocks other credential readers or the background
      // refresher behind the lock's 2-second contention deadline.
      const decision = await withFileLock(this.options.authJsonPath, () => this.decideRefreshLocked())
      if (isAborted(signal)) return undefined
      if (decision.mode === 'absent') {
        this.publishStatus(statusFromFile(decision.file, this.available, this.codexVersion, this.options.credentialRef))
        return undefined
      }
      if (decision.mode === 'ready') {
        this.publishStatus(statusFromFile(decision.snapshot.file, this.available, this.codexVersion, this.options.credentialRef))
        this.recordResolved(decision.snapshot)
        return credentialFromFile(decision.snapshot.file)
      }
      try {
        const reply = await refreshTokens(decision.refreshToken, this.options.fetchImpl ?? fetch, signal)
        if (isAborted(signal)) return undefined
        const adopted = await withFileLock(
          this.options.authJsonPath,
          () => this.adoptRefreshedLocked(decision.snapshot.file, reply, signal),
        )
        if (isAborted(signal) || adopted === undefined) return undefined
        this.publishStatus(statusFromFile(adopted.file, this.available, this.codexVersion, this.options.credentialRef))
        this.recordResolved(adopted)
        return credentialFromFile(adopted.file)
      } catch (error) {
        if (isAborted(signal)) return undefined
        // The Codex CLI does not share this lock. If it rotated the same login
        // while our refresh was in flight, recover from its newer state.
        const replacement = await readAuthSnapshot(this.options.authJsonPath)
        if (isAborted(signal)) return undefined
        const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
        if (canAdoptReplacement(decision.snapshot.file, replacement?.file, leadMs)) {
          this.publishStatus(statusFromFile(replacement.file, this.available, this.codexVersion, this.options.credentialRef))
          this.recordResolved(replacement)
          return credentialFromFile(replacement.file)
        }
        this.warnCredentialFailure(
          'token refresh failed; run `codex login` to restore the Codex Login State',
          error,
          decision.snapshot.file,
        )
        this.publishStatus(statusFromFile(replacement?.file, this.available, this.codexVersion, this.options.credentialRef))
        return undefined
      }
    } catch (error) {
      if (isAborted(signal)) return undefined
      this.warnCredentialFailure('could not coordinate the Codex Login State', error, observed)
      return undefined
    }
  }

  /**
   * Under the writer lock, read the auth file and return a side-effect-free
   * refresh decision. Callers publish/cache only after their lifecycle check.
   */
  private async decideRefreshLocked(): Promise<
    | { mode: 'absent'; file: CodexAuthFile | undefined }
    | { mode: 'ready'; snapshot: CodexAuthSnapshot }
    | { mode: 'refresh'; snapshot: CodexAuthSnapshot; refreshToken: string }
  > {
    const snapshot = await readAuthSnapshot(this.options.authJsonPath)
    if (snapshot === undefined) return { mode: 'absent', file: undefined }
    const file = snapshot.file
    const state = authState(file)
    if (state.accessToken === undefined) return { mode: 'absent', file }
    const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
    if (!needsRefresh(state, leadMs) && !refreshTooOld(file, MAX_REFRESH_AGE_MS)) {
      return { mode: 'ready', snapshot }
    }
    const refreshToken = file.tokens?.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) return { mode: 'absent', file }
    return { mode: 'refresh', snapshot, refreshToken }
  }

  /**
   * Under the writer lock: fold a refresh reply into the current document,
   * preserving unknown fields — unless another writer already refreshed while
   * the OAuth round trip was in flight, in which case its newer document wins.
   * Returns the document to serve, or `undefined` when the login is gone.
   */
  private async adoptRefreshedLocked(
    previous: CodexAuthFile,
    reply: CodexRefreshReply,
    signal?: AbortSignal,
  ): Promise<CodexAuthSnapshot | undefined> {
    if (isAborted(signal)) return undefined
    const current = await readAuthSnapshot(this.options.authJsonPath)
    if (isAborted(signal) || current === undefined) return undefined
    const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
    if (!needsRefresh(authState(current.file), leadMs) && !refreshTooOld(current.file, MAX_REFRESH_AGE_MS)) {
      return current
    }
    if (!sameRefreshLineage(previous, current.file, reply)) {
      this.publishStatus(statusFromFile(current.file, this.available, this.codexVersion, this.options.credentialRef))
      return undefined
    }
    if (!await this.commitAuthFile(mergeRefreshed(current.file, reply), signal)) return undefined
    if (isAborted(signal)) return undefined
    const persisted = await readAuthSnapshot(this.options.authJsonPath)
    if (persisted === undefined
      || needsRefresh(authState(persisted.file), leadMs)
      || refreshTooOld(persisted.file, MAX_REFRESH_AGE_MS)) return undefined
    return persisted
  }

  /** Commit one non-cancellable atomic write while keeping teardown joined. */
  private async commitAuthFile(file: CodexAuthFile, signal?: AbortSignal): Promise<boolean> {
    if (isAborted(signal)) return false
    const writer = this.options.authFileWriter ?? writeAuthFile
    const commit = Promise.resolve().then(() => writer(this.options.authJsonPath, file))
    this.commitFlights.add(commit)
    try {
      await commit
      return !isAborted(signal)
    } finally {
      this.commitFlights.delete(commit)
    }
  }

  /**
   * Populate the in-memory credential cache from a version-bound snapshot and
   * arm the next background refresh. A snapshot failure never produces a cache
   * entry, so filesystem uncertainty fails closed.
   */
  private recordResolved(snapshot: CodexAuthSnapshot): void {
    if (this.disposed) return
    const credential = credentialFromFile(snapshot.file)
    if (credential === undefined) {
      this.cachedCredential = undefined
      return
    }
    this.cachedCredential = {
      credential,
      accessTokenExpiresAt: authState(snapshot.file).accessTokenExpiresAt,
      cachedAt: Date.now(),
      fileVersion: snapshot.version,
    }
    this.scheduleBackgroundRefresh(snapshot.file)
  }

  /**
   * Arm one background refresh at the earlier of (access-token expiry minus
   * the refresh lead) and (the codex 8-day refresh age), each with a grace
   * lead, and never closer than the minimum delay unless a refresh is already
   * due (then it fires immediately). The timer is unref'd so it never keeps
   * the process alive, and is cleared on dispose.
   */
  private scheduleBackgroundRefresh(file: CodexAuthFile): void {
    // Every resolved snapshot supersedes the previous schedule. This matters
    // when the Codex CLI writes a login whose token expires sooner.
    this.clearRefreshTimer()
    if (this.disposed) return
    const refreshToken = file.tokens?.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) return
    const now = Date.now()
    const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
    const state = authState(file)
    let delayMs = Number.POSITIVE_INFINITY
    if (state.accessTokenExpiresAt !== undefined) {
      delayMs = Math.min(delayMs, state.accessTokenExpiresAt - now - leadMs - REFRESH_GRACE_MS)
    }
    const lastRefreshAt = typeof file.last_refresh === 'string' && file.last_refresh.length > 0
      ? Date.parse(file.last_refresh)
      : Number.NaN
    if (Number.isFinite(lastRefreshAt)) {
      delayMs = Math.min(delayMs, lastRefreshAt + MAX_REFRESH_AGE_MS - now - REFRESH_GRACE_MS)
    }
    if (!Number.isFinite(delayMs)) return
    const due = needsRefresh(state, leadMs) || refreshTooOld(file, MAX_REFRESH_AGE_MS)
    const delay = due
      ? 0
      : Math.max(BACKGROUND_REFRESH_MIN_DELAY_MS, Math.min(delayMs, MAX_TIMER_DELAY_MS))
    const timer = setTimeout(() => {
      this.refreshTimer = undefined
      // Keep the timer callback linked to the lifecycle-tracked operation.
      return this.startBackgroundRefresh()
    }, delay)
    timer.unref?.()
    this.refreshTimer = timer
  }
  /** Start or join the one lifecycle-tracked background refresh flight. */
  private startBackgroundRefresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.backgroundRefreshFlight !== undefined) return this.backgroundRefreshFlight
    const flight = this.refreshInBackground(this.lifecycleAbort.signal).finally(() => {
      if (this.backgroundRefreshFlight === flight) this.backgroundRefreshFlight = undefined
    })
    this.backgroundRefreshFlight = flight
    return flight
  }

  /**
   * Refresh the token set ahead of the request path when the auth file says it
   * is due. The request path still refreshes synchronously when a token is
   * genuinely needed, but this pre-arms it while the process is alive, so the
   * common case never waits on the OAuth round trip. Like the request path,
   * the OAuth round trip happens outside the writer lock (short critical
   * sections only), so a slow token endpoint never blocks other readers;
   * failures are logged and retried later.
   */
  private async refreshInBackground(signal: AbortSignal): Promise<void> {
    let retry = false
    try {
      if (isAborted(signal)) return
      const decision = await withFileLock(this.options.authJsonPath, () => this.decideRefreshLocked())
      if (isAborted(signal)) return
      if (decision.mode === 'absent') {
        this.publishStatus(statusFromFile(decision.file, this.available, this.codexVersion, this.options.credentialRef))
        return
      }
      if (decision.mode === 'ready') {
        // Already fresh — a request-path refresh won the race, or the login
        // changed under us. Re-arm from the current document.
        this.publishStatus(statusFromFile(decision.snapshot.file, this.available, this.codexVersion, this.options.credentialRef))
        this.recordResolved(decision.snapshot)
        return
      }
      try {
        const reply = await refreshTokens(decision.refreshToken, this.options.fetchImpl ?? fetch, signal)
        if (isAborted(signal)) return
        const adopted = await withFileLock(
          this.options.authJsonPath,
          () => this.adoptRefreshedLocked(decision.snapshot.file, reply, signal),
        )
        if (isAborted(signal)) return
        if (adopted === undefined) {
          // A successful reply can still be unusable when the CLI changed the
          // account or refresh-token lineage in flight. Retry from that newer
          // state instead of silently losing proactive refresh.
          retry = true
        } else {
          this.publishStatus(statusFromFile(adopted.file, this.available, this.codexVersion, this.options.credentialRef))
          this.recordResolved(adopted)
        }
      } catch (error) {
        if (isAborted(signal)) return
        // The Codex CLI does not share this lock. If it rotated the same
        // login while our refresh was in flight, adopt its newer state.
        const replacement = await readAuthSnapshot(this.options.authJsonPath)
        if (isAborted(signal)) return
        const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
        if (canAdoptReplacement(decision.snapshot.file, replacement?.file, leadMs)) {
          this.publishStatus(statusFromFile(replacement.file, this.available, this.codexVersion, this.options.credentialRef))
          this.recordResolved(replacement)
          return
        }
        this.warnCredentialFailure('background token refresh failed; will retry later', error, decision.snapshot.file)
        retry = true
      }
    } catch (error) {
      if (isAborted(signal)) return
      this.warnCredentialFailure('background token refresh could not coordinate; will retry later', error)
      retry = true
    }
    if (retry && !this.disposed) this.scheduleBackgroundRetry()
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  /** Re-arm the background refresh after a failure. */
  private scheduleBackgroundRetry(): void {
    if (this.disposed || this.refreshTimer !== undefined) return
    const timer = setTimeout(() => {
      this.refreshTimer = undefined
      // Keep the timer callback linked to the lifecycle-tracked operation.
      return this.startBackgroundRefresh()
    }, BACKGROUND_REFRESH_RETRY_MS)
    timer.unref?.()
    this.refreshTimer = timer
  }

  private publishStatus(status: CodexAuthStatusView): CodexAuthStatusView {
    if (this.disposed || sameStatus(this.lastStatus, status)) return status
    this.lastStatus = status
    for (const listener of this.statusListeners) {
      try { listener() } catch { /* one observer cannot disrupt auth */ }
    }
    return status
  }

  private warnCredentialFailure(message: string, error: unknown, file?: CodexAuthFile): void {
    this.ctx.logger.warn('codex-auth: %s (%s)', message, safeDiagnostic(error, file))
  }

  /**
   * Probe the codex CLI once at startup without blocking the event loop;
   * failures (missing binary, timeout, non-zero exit) leave the service
   * unavailable.
   */
  private probeCodex(): void {
    this.ctx.effect(() => {
      let child: ReturnType<typeof spawn> | undefined
      let settled = false
      let spawned = false
      let terminal = false
      let stopRequested = false
      let stopSpawnedFlight: Promise<void> | undefined
      let resolveSpawnOutcome!: () => void
      let resolveClosed!: () => void
      const spawnOutcome = new Promise<void>(resolve => { resolveSpawnOutcome = resolve })
      const closed = new Promise<void>(resolve => { resolveClosed = resolve })
      const stopTimeoutMs = this.options.probeStopTimeoutMs ?? PROBE_STOP_TIMEOUT_MS
      const markTerminal = (): void => {
        if (terminal) return
        terminal = true
        resolveSpawnOutcome()
        resolveClosed()
      }
      const detach = (): void => {
        try { child?.stdout?.destroy() } catch { /* best effort */ }
        try { child?.stderr?.destroy() } catch { /* best effort */ }
        try { child?.unref() } catch { /* best effort */ }
      }
      const kill = (signal: NodeJS.Signals): boolean => {
        try { return child?.kill(signal) === true } catch { return false }
      }
      const stopSpawned = (): Promise<void> => {
        if (stopSpawnedFlight !== undefined) return stopSpawnedFlight
        stopSpawnedFlight = (async () => {
          if (terminal) return
          kill('SIGTERM')
          if (await waitForSettlement(closed, stopTimeoutMs)) return
          kill('SIGKILL')
          detach()
          await waitForSettlement(closed, stopTimeoutMs)
        })()
        return stopSpawnedFlight
      }
      const stop = async (): Promise<void> => {
        stopRequested = true
        if (!spawned && !terminal && !await waitForSettlement(spawnOutcome, stopTimeoutMs)) {
          // A pathological spawner produced neither `spawn` nor `error`.
          // Detach its pipes now; a late `spawn` event still triggers stopSpawned.
          detach()
          return
        }
        if (spawned && !terminal) await stopSpawned()
      }
      const finish = (version: string | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!this.disposed) this.codexVersion = version
      }
      const timer = setTimeout(() => {
        finish(undefined)
        void stop()
      }, PROBE_TIMEOUT_MS)
      timer.unref?.()
      try {
        child = (this.options.spawnImpl ?? spawn)(this.options.codexCommand, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout?.on('data', (chunk) => { output += String(chunk) })
        child.stderr?.on('data', (chunk) => { output += String(chunk) })
        child.on('spawn', () => {
          spawned = true
          resolveSpawnOutcome()
          if (stopRequested) void stopSpawned()
        })
        child.on('error', () => {
          finish(undefined)
          if (spawned) void stopSpawned()
          else markTerminal()
        })
        child.on('close', (code) => {
          markTerminal()
          const line = code === 0 ? output.trim().split('\n')[0] : undefined
          finish(typeof line === 'string' && line.length > 0 ? line : undefined)
        })
      } catch {
        markTerminal()
        finish(undefined)
      }
      return async () => {
        settled = true
        clearTimeout(timer)
        await stop()
      }
    }, 'codex-auth: CLI probe')
  }
}

async function probeUsage(
  fetchImpl: typeof fetch,
  credential: CodexCredential,
  signal: AbortSignal,
): Promise<CodexUsageView> {
  const response = await fetchImpl(CODEX_USAGE_ENDPOINT, {
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      ...credential.accountId === undefined ? {} : { 'chatgpt-account-id': credential.accountId },
      'content-type': 'application/json',
      'user-agent': 'dsh-codex-auth/0.1.0',
    },
    signal,
  })
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* best effort */ }
    return {}
  }
  const text = await readBoundedResponseText(response, CODEX_USAGE_MAX_BYTES, signal, {
    tooLarge: () => new Error('usage response exceeded the encoded size limit'),
    cancelled: () => new Error('usage probe was cancelled'),
  })
  return usageFromPayload(JSON.parse(text) as unknown)
}

function credentialFromFile(file: CodexAuthFile): CodexCredential | undefined {
  const accessToken = file.tokens?.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  const accessFacts = decodeAccessToken(accessToken)
  const idFacts = typeof file.tokens?.id_token === 'string' ? decodeAccessToken(file.tokens.id_token) : {}
  const accountId = nonBlank(file.tokens?.account_id) ?? accessFacts.chatgptAccountId ?? idFacts.chatgptAccountId
  const planType = idFacts.chatgptPlanType ?? accessFacts.chatgptPlanType
  return {
    accessToken,
    ...(accountId === undefined ? {} : { accountId }),
    ...(planType === undefined ? {} : { planType }),
  }
}

function statusFromFile(
  file: CodexAuthFile | undefined,
  available: boolean,
  codexVersion: string | undefined,
  credentialReference: CredentialRef,
): CodexAuthStatusView {
  const state = authState(file)
  const credential = file === undefined ? undefined : credentialFromFile(file)
  const authMode = nonBlank(file?.auth_mode)
  const lastRefreshAt = nonBlank(file?.last_refresh)
  return {
    available,
    configured: state.accessToken !== undefined,
    ...authMode === undefined ? {} : { authMode },
    ...codexVersion === undefined ? {} : { codexVersion },
    ...state.accessTokenExpiresAt === undefined
      ? {}
      : { tokenExpiresAt: new Date(state.accessTokenExpiresAt).toISOString() },
    ...lastRefreshAt === undefined ? {} : { lastRefreshAt },
    ...credential?.accountId === undefined ? {} : { accountId: credential.accountId },
    ...credential?.planType === undefined ? {} : { planType: credential.planType },
    credentialRef: credentialReference,
    authFileExists: file !== undefined,
  }
}

function sameRefreshLineage(
  previous: CodexAuthFile,
  current: CodexAuthFile,
  reply: CodexRefreshReply,
): boolean {
  const previousRefreshToken = nonBlank(previous.tokens?.refresh_token)
  const currentRefreshToken = nonBlank(current.tokens?.refresh_token)
  if (previousRefreshToken === undefined || currentRefreshToken !== previousRefreshToken) return false

  const knownAccountIds = [
    credentialFromFile(previous)?.accountId,
    credentialFromFile(current)?.accountId,
    nonBlank(reply.account_id),
  ].filter((accountId): accountId is string => accountId !== undefined)
  return knownAccountIds.every(accountId => accountId === knownAccountIds[0])
}

function canAdoptReplacement(
  previous: CodexAuthFile,
  replacement: CodexAuthFile | undefined,
  refreshLeadMs: number,
): replacement is CodexAuthFile {
  if (replacement === undefined) return false
  const before = credentialFromFile(previous)
  const after = credentialFromFile(replacement)
  if (before === undefined || after === undefined || before.accessToken === after.accessToken) return false
  // Account identity must be known on both sides: unknown does not prove a match.
  if (before.accountId === undefined || after.accountId === undefined || before.accountId !== after.accountId) return false
  return !needsRefresh(authState(replacement), refreshLeadMs)
}

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Extract the settings-relevant facts from a `/wham/usage` payload, or none. */
export function usageFromPayload(value: unknown): CodexUsageView {
  if (!isRecord(value)) return {}
  const planType = nonBlank(typeof value.plan_type === 'string' ? value.plan_type : undefined)
  const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : undefined
  const weekly = rateLimit === undefined
    ? undefined
    : [rateLimit.primary_window, rateLimit.secondary_window].find(candidate => (
        isRecord(candidate) && candidate.limit_window_seconds === WEEKLY_USAGE_WINDOW_SECONDS
      ))
  let weeklyRemainingPercent: number | undefined
  let weeklyResetAt: string | undefined
  if (isRecord(weekly) && typeof weekly.used_percent === 'number' && Number.isFinite(weekly.used_percent)) {
    weeklyRemainingPercent = Math.min(100, Math.max(0, Math.round(100 - weekly.used_percent)))
  }
  if (isRecord(weekly) && Number.isSafeInteger(weekly.reset_at) && (weekly.reset_at as number) > 0) {
    const reset = new Date((weekly.reset_at as number) * 1000)
    if (Number.isFinite(reset.getTime())) weeklyResetAt = reset.toISOString()
  }
  return {
    ...planType === undefined ? {} : { planType },
    ...weeklyRemainingPercent === undefined ? {} : { weeklyRemainingPercent },
    ...weeklyResetAt === undefined ? {} : { weeklyResetAt },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeDiagnostic(error: unknown, _file?: CodexAuthFile): string {
  // Auth-file parse and OAuth errors may echo arbitrary credential text. Keep
  // only an error class and an optional HTTP status rather than guessing which
  // opaque strings are secret.
  const name = error instanceof Error && error.name.length > 0 ? error.name : 'Error'
  const message = error instanceof Error ? error.message : ''
  const status = /(?:HTTP\s*)?([45]\d\d)\b/iu.exec(message)?.[1]
  return status === undefined ? name.slice(0, 80) : `${name.slice(0, 64)} (HTTP ${status})`
}

function sameStatus(left: CodexAuthStatusView | undefined, right: CodexAuthStatusView): boolean {
  if (left === undefined) return false
  return left.available === right.available
    && left.configured === right.configured
    && left.authMode === right.authMode
    && left.codexVersion === right.codexVersion
    && left.tokenExpiresAt === right.tokenExpiresAt
    && left.lastRefreshAt === right.lastRefreshAt
    && left.accountId === right.accountId
    && left.planType === right.planType
    && left.credentialRef === right.credentialRef
    && left.authFileExists === right.authFileExists
}

function waitForSettlement(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs))
    timer.unref?.()
    void task.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function boundedSignal(parents: readonly (AbortSignal | undefined)[], timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const active = parents.filter((parent): parent is AbortSignal => parent !== undefined)
  const onParentAbort = (): void => {
    controller.abort(active.find(parent => parent.aborted)?.reason)
  }
  const aborted = active.find(parent => parent.aborted)
  if (aborted !== undefined) controller.abort(aborted.reason)
  else for (const parent of active) parent.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error(`usage probe timed out after ${String(timeoutMs)}ms`)),
    Math.max(1, timeoutMs),
  )
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      for (const parent of active) parent.removeEventListener('abort', onParentAbort)
    },
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

function waitForAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function waitForCredential(
  flight: Promise<CodexCredential | undefined>,
  signal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal,
): Promise<CodexCredential | undefined> {
  throwIfAborted(signal)
  if (lifecycleSignal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onCallerAbort)
      lifecycleSignal.removeEventListener('abort', onLifecycleAbort)
    }
    const onCallerAbort = (): void => {
      cleanup()
      reject(signal?.reason)
    }
    const onLifecycleAbort = (): void => {
      cleanup()
      resolve(undefined)
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    lifecycleSignal.addEventListener('abort', onLifecycleAbort, { once: true })
    flight.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}
