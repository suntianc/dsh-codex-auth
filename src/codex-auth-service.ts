/**
 * The `codexAuth` service: login status and login-flow startup for the web
 * surface. Status is value-free (no token material ever leaves this service),
 * and login only spawns the official codex CLI, which owns the whole flow —
 * browser PKCE by default, device-code on request.
 *
 * @module dsh-codex-auth/codex-auth-service
 */

import { spawn, spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  authState, decodeAccessToken, DEFAULT_REFRESH_LEAD_MS, MAX_REFRESH_AGE_MS, mergeRefreshed,
  needsRefresh, readAuthFile, refreshTokens, refreshTooOld, writeAuthFile,
} from './codex-auth.ts'
import type { CodexAuthFile } from './codex-auth.ts'
import type { CodexAuthLoginMode, CodexAuthStatusView } from './rpc-contract.ts'
export type { CodexAuthLoginMode, CodexAuthStatusView } from './rpc-contract.ts'

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
}

/** Host-only credential facts returned at an authenticated operation boundary. */
export interface CodexCredential {
  accessToken: string
  accountId?: string
  /** Locally decoded plan claim; absence means unknown, not unavailable. */
  planType?: string
}

/** One refresh/read operation shared by every in-process consumer of an auth path. */
const credentialFlights = new Map<string, Promise<CodexCredential | undefined>>()

/**
 * The codexAuth service. Constructing it registers it as `codexAuth`; this
 * package's dedicated Connection RPC channel is its only browser transport.
 */
export class CodexAuthService extends Service {
  private codexVersion: string | undefined
  private lastStatus: CodexAuthStatusView | undefined
  private readonly statusListeners = new Set<() => void>()

  constructor(ctx: Context, private readonly options: CodexAuthServiceOptions) {
    super(ctx, 'codexAuth')
    this.probeCodex()
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
   * Resolve credentials for one authenticated operation. Every consumer shares
   * one in-process flight, then re-reads under the cross-process writer lock
   * before deciding whether to refresh.
   */
  credential(signal?: AbortSignal): Promise<CodexCredential | undefined> {
    throwIfAborted(signal)
    const path = this.options.authJsonPath
    let flight = credentialFlights.get(path)
    if (flight === undefined) {
      flight = this.resolveCredential().finally(() => {
        if (credentialFlights.get(path) === flight) credentialFlights.delete(path)
      })
      credentialFlights.set(path, flight)
    }
    return waitForCredential(flight, signal)
  }

  /** Describe the current login state without exposing any token material. */
  async status(): Promise<CodexAuthStatusView> {
    let file: CodexAuthFile | undefined
    try {
      file = await readAuthFile(this.options.authJsonPath)
    } catch (error) {
      this.warnCredentialFailure('status could not read the Codex Login State', error)
    }
    return this.publishStatus(statusFromFile(file, this.available, this.codexVersion, this.options.credentialRef))
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
      const child = spawn(this.options.codexCommand, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return Promise.resolve({ started: true })
    } catch (error) {
      return Promise.reject(new Error(
        `codex-auth: failed to start ${this.options.codexCommand} login: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }

  /** Resolve from the latest locked document and refresh at most once. */
  private async resolveCredential(): Promise<CodexCredential | undefined> {
    let observed: CodexAuthFile | undefined
    try {
      observed = await readAuthFile(this.options.authJsonPath)
    } catch (error) {
      // The pre-lock read is only a hint: another DSH process or Codex CLI may
      // replace a missing or malformed document before this process owns the lock.
      this.warnCredentialFailure('pre-lock read could not inspect the Codex Login State', error)
    }

    try {
      return await withFileLock(this.options.authJsonPath, async () => {
        const file = await readAuthFile(this.options.authJsonPath)
        const state = authState(file)
        if (file === undefined || state.accessToken === undefined) {
          this.publishStatus(statusFromFile(file, this.available, this.codexVersion, this.options.credentialRef))
          return undefined
        }
        const leadMs = this.options.refreshLeadMs ?? DEFAULT_REFRESH_LEAD_MS
        if (!needsRefresh(state, leadMs) && !refreshTooOld(file, MAX_REFRESH_AGE_MS)) {
          this.publishStatus(statusFromFile(file, this.available, this.codexVersion, this.options.credentialRef))
          return credentialFromFile(file)
        }

        const refreshToken = file.tokens?.refresh_token
        if (typeof refreshToken !== 'string' || refreshToken.length === 0) return undefined
        try {
          const reply = await refreshTokens(refreshToken, this.options.fetchImpl ?? fetch)
          // Merge into the document re-read while locked, preserving unknown fields.
          const refreshed = mergeRefreshed(file, reply)
          await writeAuthFile(this.options.authJsonPath, refreshed)
          this.publishStatus(statusFromFile(refreshed, this.available, this.codexVersion, this.options.credentialRef))
          return credentialFromFile(refreshed)
        } catch (error) {
          // The Codex CLI does not share this lock. If it rotated the same login
          // while our refresh was in flight, recover from its newer state.
          const replacement = await readAuthFile(this.options.authJsonPath)
          if (canAdoptReplacement(file, replacement, leadMs)) {
            this.publishStatus(statusFromFile(replacement, this.available, this.codexVersion, this.options.credentialRef))
            return credentialFromFile(replacement)
          }
          this.warnCredentialFailure(
            'token refresh failed; run `codex login` to restore the Codex Login State',
            error,
            file,
          )
          this.publishStatus(statusFromFile(replacement, this.available, this.codexVersion, this.options.credentialRef))
          return undefined
        }
      })
    } catch (error) {
      this.warnCredentialFailure('could not coordinate the Codex Login State', error, observed)
      return undefined
    }
  }

  private publishStatus(status: CodexAuthStatusView): CodexAuthStatusView {
    if (sameStatus(this.lastStatus, status)) return status
    this.lastStatus = status
    for (const listener of this.statusListeners) {
      try { listener() } catch { /* one observer cannot disrupt auth */ }
    }
    return status
  }

  private warnCredentialFailure(message: string, error: unknown, file?: CodexAuthFile): void {
    this.ctx.logger.warn('codex-auth: %s (%s)', message, safeDiagnostic(error, file))
  }

  /** Probe the codex CLI once at startup; failures leave the service unavailable. */
  private probeCodex(): void {
    try {
      const result = spawnSync(this.options.codexCommand, ['--version'], { encoding: 'utf8', timeout: 5000 })
      if (result.error !== undefined) return
      if (result.status !== 0) return
      const line = result.stdout.trim().split('\n')[0]
      if (typeof line === 'string' && line.length > 0) this.codexVersion = line
    } catch {
      this.codexVersion = undefined
    }
  }
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason
}

function waitForCredential(
  flight: Promise<CodexCredential | undefined>,
  signal: AbortSignal | undefined,
): Promise<CodexCredential | undefined> {
  if (signal === undefined) return flight
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    flight.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
