/**
 * Codex CLI login-state access for the DeepSeek Harness: read, refresh, and
 * atomically persist the ChatGPT OAuth token set in the codex auth file
 * (`~/.codex/auth.json`, or `$CODEX_HOME/auth.json` when CODEX_HOME is set).
 *
 * The file is the codex CLI's own. This module only (a) reads the current
 * access token for a request, (b) refreshes it through the official OAuth
 * refresh endpoint when it is about to expire, writing the result back with
 * the same atomic-write discipline the codex CLI itself uses, and (c) reads
 * status facts for configuration surfaces. No token value is ever logged or
 * emitted by the status path.
 *
 * @module dsh-codex-auth/codex-auth
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { open, readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** The OAuth client id the official Codex CLI registers against auth.openai.com. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** The OAuth token endpoint the codex CLI refreshes through. */
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Default lead time before the access token expires that a refresh is triggered. */
export const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000

/** Refresh when the last recorded refresh is older than this (the codex CLI's own TOKEN_REFRESH_INTERVAL). */
export const MAX_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000

/** The token set the codex CLI persists; unknown fields are preserved. */
export interface CodexTokenSet {
  id_token?: string
  access_token?: string
  refresh_token?: string
  account_id?: string
}

/** The codex auth document; unknown top-level fields are preserved. */
export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string
  tokens?: CodexTokenSet
  last_refresh?: string
}

/** Stable identity/freshness facts for the exact auth-file inode that was read. */
export interface CodexAuthFileVersion {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/** Parsed auth state bound to the exact file version its bytes came from. */
export interface CodexAuthSnapshot {
  file: CodexAuthFile
  version: CodexAuthFileVersion
}

/** The refresh endpoint's reply; fields the codex CLI records are carried over. */
export interface CodexRefreshReply {
  access_token: string
  refresh_token?: string
  id_token?: string
  account_id?: string
}

/** One auth file plus its decoded access-token facts. */
export interface CodexAuthState {
  file: CodexAuthFile | undefined
  /** The current access token, when present. */
  accessToken: string | undefined
  /** The access token's expiry in epoch milliseconds, when decodable. */
  accessTokenExpiresAt: number | undefined
}

/** The auth file path for the current environment (CODEX_HOME overrides ~/.codex). */
export function defaultAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME
  return home !== undefined && home.length > 0 ? join(home, 'auth.json') : join(homedir(), '.codex', 'auth.json')
}

/**
 * Decode the JWT payload of a codex access token without verifying it. The
 * chatgpt_account_id claim is the one pi-ai's codex provider extracts to set
 * the `chatgpt-account-id` request header.
 */
export function decodeAccessToken(token: string): {
  expSeconds?: number
  chatgptAccountId?: string
  chatgptPlanType?: string
} {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return {}
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown
      'https://api.openai.com/auth'?: {
        chatgpt_account_id?: unknown
        chatgpt_plan_type?: unknown
      }
    }
    const auth = payload['https://api.openai.com/auth']
    return {
      ...typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? { expSeconds: payload.exp } : {},
      ...typeof auth?.chatgpt_account_id === 'string'
        ? { chatgptAccountId: auth.chatgpt_account_id }
        : {},
      ...typeof auth?.chatgpt_plan_type === 'string'
        ? { chatgptPlanType: auth.chatgpt_plan_type }
        : {},
    }
  } catch {
    return {}
  }
}

/**
 * Read and parse the codex auth file. Absence answers `undefined`; a malformed
 * document throws — a file that exists but cannot be trusted must never read
 * as "no login" on the settings page.
 */
export async function readAuthFile(path: string): Promise<CodexAuthFile | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  return parseAuthFile(path, text)
}

/**
 * Read auth bytes and version facts from one open file descriptor. Atomic
 * replacement after the open leaves this snapshot bound to the old inode, so
 * a later path stat reliably invalidates it instead of pairing old bytes with
 * a new file's timestamp.
 */
export async function readAuthSnapshot(path: string): Promise<CodexAuthSnapshot | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  try {
    const before = versionFromStat(await handle.stat({ bigint: true }))
    const text = await handle.readFile('utf8')
    const after = versionFromStat(await handle.stat({ bigint: true }))
    if (!sameAuthFileVersion(before, after)) {
      throw new Error(`codex-auth: ${path} changed while it was being read`)
    }
    return { file: parseAuthFile(path, text), version: after }
  } finally {
    await handle.close()
  }
}

/** Read only the current path version for a cheap credential-cache check. */
export async function readAuthFileVersion(path: string): Promise<CodexAuthFileVersion | undefined> {
  try {
    return versionFromStat(await stat(path, { bigint: true }))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/** Exact equality for the inode and freshness fields used by the auth cache. */
export function sameAuthFileVersion(left: CodexAuthFileVersion, right: CodexAuthFileVersion): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function versionFromStat(value: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}): CodexAuthFileVersion {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  }
}

function parseAuthFile(path: string, text: string): CodexAuthFile {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`codex-auth: ${path} must be a JSON object`)
  }
  return parsed
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The current access-token facts of one auth file. */
export function authState(file: CodexAuthFile | undefined): CodexAuthState {
  const accessToken = typeof file?.tokens?.access_token === 'string' && file.tokens.access_token.length > 0
    ? file.tokens.access_token
    : undefined
  const expSeconds = accessToken === undefined ? undefined : decodeAccessToken(accessToken).expSeconds
  return {
    file,
    accessToken,
    accessTokenExpiresAt: expSeconds === undefined ? undefined : expSeconds * 1000,
  }
}

/** Whether the access token is stale enough to warrant a refresh before use. */
export function needsRefresh(state: CodexAuthState, leadMs: number): boolean {
  return state.accessTokenExpiresAt !== undefined && state.accessTokenExpiresAt - Date.now() < leadMs
}

/** Whether the recorded refresh is old enough that codex itself would refresh (TOKEN_REFRESH_INTERVAL). */
export function refreshTooOld(file: CodexAuthFile | undefined, maxAgeMs: number): boolean {
  if (typeof file?.last_refresh !== 'string' || file.last_refresh.length === 0) return false
  const at = Date.parse(file.last_refresh)
  return Number.isFinite(at) && Date.now() - at > maxAgeMs
}

/**
 * Refresh the token set through the official OAuth endpoint. The request
 * mirrors the codex CLI's own wire format (JSON body, same client_id), so
 * behaviour tracks the primary source exactly.
 */
export async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CodexRefreshReply> {
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) {
    throw new Error(`codex-auth: token refresh answered ${response.status}`)
  }
  const parsed: unknown = await response.json()
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('codex-auth: token refresh reply is not a JSON object')
  }
  const reply = parsed as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; account_id?: unknown }
  if (typeof reply.access_token !== 'string' || reply.access_token.length === 0) {
    throw new Error('codex-auth: token refresh reply carries no access_token')
  }
  return {
    access_token: reply.access_token,
    ...typeof reply.refresh_token === 'string' ? { refresh_token: reply.refresh_token } : {},
    ...typeof reply.id_token === 'string' ? { id_token: reply.id_token } : {},
    ...typeof reply.account_id === 'string' ? { account_id: reply.account_id } : {},
  }
}

/** Fold a refresh reply into the auth document, preserving every unknown field. */
export function mergeRefreshed(file: CodexAuthFile, reply: CodexRefreshReply): CodexAuthFile {
  return {
    ...file,
    tokens: {
      ...file.tokens,
      access_token: reply.access_token,
      ...reply.refresh_token === undefined ? {} : { refresh_token: reply.refresh_token },
      ...reply.id_token === undefined ? {} : { id_token: reply.id_token },
      ...reply.account_id === undefined ? {} : { account_id: reply.account_id },
    },
    last_refresh: new Date().toISOString(),
  }
}

/** Persist an auth document atomically at 0600, matching the codex CLI's own writes. */
export async function writeAuthFile(path: string, file: CodexAuthFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
