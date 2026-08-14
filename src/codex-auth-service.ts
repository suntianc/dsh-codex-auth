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
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { authState, readAuthFile } from './codex-auth.ts'
import type { CodexAuthFile } from './codex-auth.ts'
import type { CodexAuthLoginMode, CodexAuthStatusView } from './rpc-contract.ts'
export type { CodexAuthLoginMode, CodexAuthStatusView } from './rpc-contract.ts'

/** Options one service instance is constructed with. */
export interface CodexAuthServiceOptions {
  /** The codex auth file path (`~/.codex/auth.json` by default). */
  authJsonPath: string
  /** The codex CLI command to spawn for login and version probing. */
  codexCommand: string
  /** The CredentialRef the LLM adapter resolves through the credentials seam. */
  credentialRef: CredentialRef
}

/**
 * The codexAuth service. Constructing it registers it as `codexAuth`; this
 * package's dedicated Connection RPC channel is its only browser transport.
 */
export class CodexAuthService extends Service {
  private codexVersion: string | undefined

  constructor(ctx: Context, private readonly options: CodexAuthServiceOptions) {
    super(ctx, 'codexAuth')
    this.probeCodex()
  }

  /** Whether the codex CLI resolved at startup. */
  get available(): boolean {
    return this.codexVersion !== undefined
  }

  /** Describe the current login state without exposing any token material. */
  async status(): Promise<CodexAuthStatusView> {
    let file: CodexAuthFile | undefined
    try {
      file = await readAuthFile(this.options.authJsonPath)
    } catch (error) {
      this.ctx.logger.warn('codex-auth: status could not read %s', this.options.authJsonPath)
      this.ctx.logger.warn(error)
    }
    const state = authState(file)
    return {
      available: this.available,
      configured: state.accessToken !== undefined,
      ...typeof file?.auth_mode === 'string' && file.auth_mode.length > 0 ? { authMode: file.auth_mode } : {},
      ...this.codexVersion === undefined ? {} : { codexVersion: this.codexVersion },
      ...state.accessTokenExpiresAt === undefined
        ? {}
        : { tokenExpiresAt: new Date(state.accessTokenExpiresAt).toISOString() },
      ...typeof file?.last_refresh === 'string' && file.last_refresh.length > 0 ? { lastRefreshAt: file.last_refresh } : {},
      credentialRef: this.options.credentialRef,
      authFileExists: file !== undefined,
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
      const child = spawn(this.options.codexCommand, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return Promise.resolve({ started: true })
    } catch (error) {
      return Promise.reject(new Error(
        `codex-auth: failed to start ${this.options.codexCommand} login: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
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
