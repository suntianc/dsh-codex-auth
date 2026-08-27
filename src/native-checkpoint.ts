/**
 * Versioned, provider-owned durable state for replaying Codex Responses v2
 * compaction without widening DSH's core content vocabulary.
 *
 * @module dsh-codex-auth/native-checkpoint
 */

import { createHash } from 'node:crypto'
import { isPlainJsonTree } from './json-tree.ts'
import { installedPackageVersion } from './package-version.ts'

/** Stable declaration-merged content tag owned by this package. */
export const CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE = 'codex-native-checkpoint' as const
/** Initial durable schema generation. */
export const CODEX_NATIVE_CHECKPOINT_SCHEMA_VERSION = 1 as const
/** Provider codec interpreted by the Codex Adapter. */
export const CODEX_NATIVE_CHECKPOINT_CODEC = 'openai-responses-v2' as const
/** Initial provider codec generation. */
export const CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION = 1 as const
/** Retained-history policy pinned by the parent specification. */
export const CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY = 'codex-v2-retained-message-groups' as const
/** Initial retained-history policy generation. */
export const CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION = 1 as const
/** Replay estimate identity pinned by the parent specification. */
export const CODEX_NATIVE_CHECKPOINT_ESTIMATOR = 'codex-v2-json-bytes-div-4-v1' as const
/** Serialized custom-block ceiling, including its JSON carrier. */
export const MAX_CODEX_NATIVE_CHECKPOINT_BYTES = 2 * 1024 * 1024
/** Exact runtime pair whose rc.2 message and pi payload conversion this replay uses. */
export const CODEX_NATIVE_REPLAY_COMPATIBILITY = Object.freeze({
  dsh: '0.1.1-rc.2',
  piAi: '0.82.1',
})

/** Installed package facts that decide whether marker replay is safe. */
export interface CodexNativeReplayRuntimeVersions {
  readonly dshLlm: string
  readonly dshPiAi: string
  readonly piAi: string
}

/** Return false on an unobserved converter/runtime pair so callers can use Portable text. */
export function isCodexNativeReplayRuntimeCompatible(
  actual: CodexNativeReplayRuntimeVersions = installedNativeReplayVersions(),
): boolean {
  return actual.dshLlm === CODEX_NATIVE_REPLAY_COMPATIBILITY.dsh
    && actual.dshPiAi === CODEX_NATIVE_REPLAY_COMPATIBILITY.dsh
    && actual.piAi === CODEX_NATIVE_REPLAY_COMPATIBILITY.piAi
}

/** Lossless JSON values accepted by the checkpoint carrier. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
/** Canonical Responses items are JSON objects with provider-owned fields. */
export type CodexResponsesItem = { readonly [key: string]: JsonValue }

/** Optional provider usage facts retained for diagnostics only. */
export interface CodexNativeCheckpointUsage {
  readonly source: 'reported' | 'estimated'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** First durable Codex Native Checkpoint schema. */
export interface CodexNativeCheckpointV1 {
  readonly schemaVersion: typeof CODEX_NATIVE_CHECKPOINT_SCHEMA_VERSION
  readonly codec: {
    readonly kind: typeof CODEX_NATIVE_CHECKPOINT_CODEC
    readonly generation: typeof CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION
  }
  readonly retention: {
    readonly policy: typeof CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY
    readonly generation: typeof CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION
  }
  readonly provenance: {
    readonly provider: 'openai-codex'
    readonly model: string
    readonly accountHash: string
  }
  readonly compatibilityDigest: string
  readonly replay: {
    readonly estimator: typeof CODEX_NATIVE_CHECKPOINT_ESTIMATOR
    readonly estimatedTokens: number
  }
  readonly usage?: CodexNativeCheckpointUsage
  readonly replacementItems: readonly CodexResponsesItem[]
}

/** Opaque durable carrier duplicated by Basic into summary and replacement events. */
export interface CodexNativeCheckpointBlock {
  readonly type: typeof CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE
  /** Serialized schema JSON; kept opaque so unknown canonical item fields round-trip. */
  readonly state: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    /** Package-owned opaque Codex replay state; clients present only sibling text. */
    'codex-native-checkpoint': CodexNativeCheckpointBlock
  }
}

export type CodexNativeCheckpointDecodeResult =
  | { readonly ok: true; readonly checkpoint: CodexNativeCheckpointV1 }
  | { readonly ok: false; readonly reason: string }

/** Semantic request controls included in the canonical replay compatibility digest. */
export interface CodexNativeCheckpointCompatibilityInput {
  readonly provider: string
  readonly model: string
  readonly accountHash: string
  readonly instructions: string
  readonly tools: JsonValue
  readonly parallelToolCalls: boolean
  readonly toolChoice: JsonValue
  readonly reasoning: JsonValue
  readonly text: JsonValue
  readonly serviceTier: JsonValue
}

/** Hash one non-secret account identity without persisting the raw identifier. */
export function hashCodexAccountIdentity(accountId: string): string {
  return sha256('dsh-codex-auth/account/v1', accountId)
}

/** Canonical compatibility identity for one effective Codex Responses request. */
export function codexNativeCheckpointCompatibilityDigest(
  input: CodexNativeCheckpointCompatibilityInput,
): string {
  if (!isPlainJsonTree(input)) {
    throw new Error('Codex Native Checkpoint compatibility requires lossless JSON')
  }
  return sha256('dsh-codex-auth/native-checkpoint-compatibility/v1', canonicalJson({
    accountHash: input.accountHash,
    codec: {
      generation: CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION,
      kind: CODEX_NATIVE_CHECKPOINT_CODEC,
    },
    instructions: input.instructions,
    model: input.model,
    parallelToolCalls: input.parallelToolCalls,
    provider: input.provider,
    reasoning: input.reasoning,
    retention: {
      generation: CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION,
      policy: CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY,
    },
    serviceTier: input.serviceTier,
    text: input.text,
    toolChoice: input.toolChoice,
    tools: input.tools,
  }))
}

/** Encode one validated v1 state into its opaque declaration-merged block. */
export function encodeCodexNativeCheckpoint(
  checkpoint: CodexNativeCheckpointV1,
): CodexNativeCheckpointBlock {
  if (!isPlainJsonTree(checkpoint)) {
    throw new Error('Codex Native Checkpoint requires lossless JSON')
  }
  const block = Object.freeze({
    type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    state: JSON.stringify(checkpoint),
  })
  const decoded = decodeCodexNativeCheckpoint(block)
  if (!decoded.ok) throw new Error(`invalid Codex Native Checkpoint: ${decoded.reason}`)
  return block
}

/** Decode and validate one candidate without exposing malformed state to replay. */
export function decodeCodexNativeCheckpoint(
  block: unknown,
): CodexNativeCheckpointDecodeResult {
  try {
    return decodeCodexNativeCheckpointUnchecked(block)
  } catch {
    return { ok: false, reason: 'invalid checkpoint structure' }
  }
}

function decodeCodexNativeCheckpointUnchecked(
  block: unknown,
): CodexNativeCheckpointDecodeResult {
  if (!isPlainJsonTree(block)
    || !isRecord(block)
    || !hasOnlyKeys(block, ['type', 'state'])
    || block.type !== CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE
    || typeof block.state !== 'string') {
    return { ok: false, reason: 'invalid content block' }
  }
  if (serializedBytes({
    type: CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
    state: block.state,
  }) > MAX_CODEX_NATIVE_CHECKPOINT_BYTES) {
    return { ok: false, reason: 'serialized checkpoint exceeds 2 MiB' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(block.state)
  } catch {
    return { ok: false, reason: 'malformed checkpoint JSON' }
  }
  if (!isPlainJsonTree(parsed)) {
    return { ok: false, reason: 'checkpoint is not lossless JSON' }
  }
  if (!isCheckpointV1(parsed)) return { ok: false, reason: 'invalid checkpoint schema' }
  if (containsForbiddenCheckpointMaterial(parsed)) {
    return { ok: false, reason: 'checkpoint contains credentials, headers, or turn state' }
  }
  return { ok: true, checkpoint: parsed }
}

function isCheckpointV1(value: unknown): value is CodexNativeCheckpointV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion',
      'codec',
      'retention',
      'provenance',
      'compatibilityDigest',
      'replay',
      'usage',
      'replacementItems',
    ])
    || value.schemaVersion !== CODEX_NATIVE_CHECKPOINT_SCHEMA_VERSION
    || !isRecord(value.codec)
    || !hasOnlyKeys(value.codec, ['kind', 'generation'])
    || value.codec.kind !== CODEX_NATIVE_CHECKPOINT_CODEC
    || value.codec.generation !== CODEX_NATIVE_CHECKPOINT_CODEC_GENERATION
    || !isRecord(value.retention)
    || !hasOnlyKeys(value.retention, ['policy', 'generation'])
    || value.retention.policy !== CODEX_NATIVE_CHECKPOINT_RETENTION_POLICY
    || value.retention.generation !== CODEX_NATIVE_CHECKPOINT_RETENTION_GENERATION
    || !isRecord(value.provenance)
    || !hasOnlyKeys(value.provenance, ['provider', 'model', 'accountHash'])
    || value.provenance.provider !== 'openai-codex'
    || !nonemptyString(value.provenance.model)
    || !sha256Identity(value.provenance.accountHash)
    || !sha256Identity(value.compatibilityDigest)
    || !isRecord(value.replay)
    || !hasOnlyKeys(value.replay, ['estimator', 'estimatedTokens'])
    || value.replay.estimator !== CODEX_NATIVE_CHECKPOINT_ESTIMATOR
    || !nonnegativeInteger(value.replay.estimatedTokens)
    || !Array.isArray(value.replacementItems)
    || !isCanonicalReplacementHistory(value.replacementItems)) return false
  return value.usage === undefined || isUsage(value.usage)
}

function isCanonicalReplacementHistory(
  items: unknown[],
): items is CodexResponsesItem[] {
  if (items.length === 0 || !isCanonicalCompactionItem(items.at(-1))) return false
  return items.slice(0, -1).every(isCanonicalRetainedUserItem)
}

function isCanonicalCompactionItem(value: unknown): value is CodexResponsesItem {
  return isRecord(value)
    && value.type === 'compaction'
    && nonemptyString(value.encrypted_content)
}

function isCanonicalRetainedUserItem(value: unknown): value is CodexResponsesItem {
  if (!isRecord(value)
    || (value.type !== undefined && value.type !== 'message')
    || value.role !== 'user') return false
  if (nonemptyString(value.content)) return true
  return Array.isArray(value.content)
    && value.content.length > 0
    && value.content.every(part => isRecord(part)
      && part.type === 'input_text'
      && nonemptyString(part.text))
}

function isUsage(value: unknown): value is CodexNativeCheckpointUsage {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'source',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ])
    && (value.source === 'reported' || value.source === 'estimated')
    && nonnegativeInteger(value.inputTokens)
    && nonnegativeInteger(value.outputTokens)
    && optionalNonnegativeInteger(value.cacheReadTokens)
    && optionalNonnegativeInteger(value.cacheWriteTokens)
    && optionalNonnegativeInteger(value.reasoningTokens)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonnegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || nonnegativeInteger(value)
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sha256Identity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

function sha256(domain: string, value: string): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(value).digest('hex')}`
}

/** Stable key-sorted JSON independent of insertion order. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`
  )).join(',')}}`
}

const FORBIDDEN_STATE_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'token',
  'idtoken',
  'secret',
  'password',
  'clientsecret',
  'oauth',
  'oauthtoken',
  'auth',
  'cookie',
  'setcookie',
  'proxyauthorization',
  'proxyauthenticate',
  'wwwauthenticate',
  'authenticationinfo',
  'credential',
  'credentials',
  'header',
  'headers',
  'requestheaders',
  'responseheaders',
  'turnstate',
  'xcodexturnstate',
  'compactiontrigger',
  'accountid',
  'sessionid',
  'requestid',
  'requestids',
  'promptcachekey',
  'previousresponseid',
  'turnid',
  'proto',
  'prototype',
  'constructor',
])

/** Scan everything except the one schema-validated terminal opaque byte string. */
function containsForbiddenCheckpointMaterial(checkpoint: CodexNativeCheckpointV1): boolean {
  const replacementItems = [...checkpoint.replacementItems]
  const terminal = replacementItems.at(-1)
  if (terminal === undefined) return true
  replacementItems[replacementItems.length - 1] = {
    ...terminal,
    encrypted_content: '',
  }
  return containsForbiddenMaterial({ ...checkpoint, replacementItems })
}

/** Reject raw request/auth state at any remaining depth. */
function containsForbiddenMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^\s*Bearer\s+/iu.test(value)
      || /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(value)
  }
  if (Array.isArray(value)) return value.some(containsForbiddenMaterial)
  if (!isRecord(value)) return false
  for (const [nestedKey, nested] of Object.entries(value)) {
    const normalized = nestedKey.toLowerCase().replace(/[^a-z0-9]/gu, '')
    if (FORBIDDEN_STATE_KEYS.has(normalized)
      || containsForbiddenMaterial(nested)) return true
  }
  return false
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function installedNativeReplayVersions(): CodexNativeReplayRuntimeVersions {
  return {
    dshLlm: installedPackageVersion('@deepseek-ai/dsh-llm', import.meta.url),
    dshPiAi: installedPackageVersion('@deepseek-ai/dsh-llm-pi-ai', import.meta.url),
    piAi: installedPackageVersion('@earendil-works/pi-ai', import.meta.url),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
