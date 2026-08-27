/**
 * Host-only request scope that carries a Native candidate around pi-ai's
 * provider-neutral message conversion and restores it at the Responses payload.
 *
 * @module dsh-codex-auth/native-checkpoint-replay
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { StreamOptions } from '@earendil-works/pi-ai'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
  codexNativeCheckpointCompatibilityDigest,
  decodeCodexNativeCheckpoint,
  hashCodexAccountIdentity,
  isCodexNativeReplayRuntimeCompatible,
} from './native-checkpoint.ts'
import type {
  CodexNativeCheckpointCompatibilityInput,
  CodexNativeCheckpointV1,
  JsonValue,
} from './native-checkpoint.ts'
import { isPlainJsonTree } from './json-tree.ts'

const CODEX_ROUTE = 'openai-codex'
const MARKER_PREFIX = '[[dsh-codex-native-checkpoint:'
/** Pinned rc.2 Basic frame digests; source text remains owned by Basic. */
const BASIC_CHECKPOINT_OPEN_SHA256 = '7986ebcdf3457b678a1d08a59d9ec746ade700b5a5cb036c72284169103aca2d'
const BASIC_CHECKPOINT_CLOSE_SHA256 = '396eac8b7d03e4f0b95511caeeb28c11c88c7e09d2e0d2fabe9c01f7d8e357a5'

type PayloadCallback = NonNullable<StreamOptions['onPayload']>

interface ReplayEntry {
  readonly marker: string
  readonly portableText: string
  readonly checkpoint: CodexNativeCheckpointV1
}

interface ReplayScope {
  readonly provider: string
  readonly model: string
  readonly entries: Map<string, ReplayEntry>
  accountHash: string | undefined
}

interface PreparedReplay {
  readonly options: GenerateOptions
  readonly scope?: ReplayScope
}

interface RestoredEntry extends ReplayEntry {
  readonly usedNative: boolean
  readonly inputIndex: number
  readonly expectedItems: readonly unknown[]
}

/**
 * One Adapter-owned coordinator. AsyncLocalStorage is used only while advancing
 * the lazy upstream iterator, so concurrent calls never share candidates.
 */
export class CodexNativeCheckpointReplay {
  private readonly storage = new AsyncLocalStorage<ReplayScope>()

  /** Record the current request's hashed account after the auth coordinator resolves it. */
  noteAccount(accountId: string | undefined): void {
    const scope = this.storage.getStore()
    if (scope === undefined) return
    scope.accountHash = accountId === undefined
      ? undefined
      : hashCodexAccountIdentity(accountId)
  }

  /**
   * Clone checkpoint-bearing messages before pi-ai can flatten the custom block,
   * then bind the resulting plan to every advancement of the lazy stream.
   */
  stream(
    options: GenerateOptions,
    dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const prepared = this.prepare(options)
    if (prepared.scope === undefined) return dispatch(prepared.options)
    return this.scopedStream(prepared.scope, prepared.options, dispatch)
  }

  /** Compose restoration before any provider callback already supplied by the caller. */
  payloadCallback(previous?: PayloadCallback): PayloadCallback | undefined {
    const scope = this.storage.getStore()
    if (scope === undefined) return previous
    return async (payload, model) => {
      const restored = this.restorePayload(scope, payload)
      const returned = await previous?.(restored.payload, model)
      const effective = returned === undefined ? restored.payload : returned
      this.validateFinalPayload(scope, restored.entries, effective)
      return effective
    }
  }

  private prepare(options: GenerateOptions): PreparedReplay {
    const entries = new Map<string, ReplayEntry>()
    const reservedText = options.messages.flatMap(message => message.content.flatMap(
      block => block.type === 'text' ? [block.text] : [],
    ))
    let changed = false
    let runtimeCompatible: boolean | undefined
    const messages = options.messages.map((message) => {
      if (message.role !== 'user') return message
      const nativeBlocks = message.content.filter(
        block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE,
      )
      if (nativeBlocks.length === 0) return message
      changed = true
      const portable = textOnlyMessage(message)
      runtimeCompatible ??= isCodexNativeReplayRuntimeCompatible()
      if (!runtimeCompatible
        || !isCompleteBasicCheckpoint(message)
        || nativeBlocks.length !== 1) return portable
      const decoded = decodeCodexNativeCheckpoint(nativeBlocks[0])
      if (!decoded.ok) return portable
      const marker = uniqueMarker(entries, reservedText)
      entries.set(marker, {
        marker,
        portableText: portable.content.map(
          block => block.type === 'text' ? block.text : '',
        ).join(''),
        checkpoint: decoded.checkpoint,
      })
      return freezeMessage({
        ...message,
        content: [{ type: 'text', text: marker }],
      })
    })
    if (!changed) return { options }
    const detached: GenerateOptions = { ...options, messages }
    if (entries.size === 0) return { options: detached }
    return {
      options: detached,
      scope: {
        provider: options.provider,
        model: options.model,
        entries,
        accountHash: undefined,
      },
    }
  }

  private async * scopedStream(
    scope: ReplayScope,
    options: GenerateOptions,
    dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk> | undefined
    try {
      iterator = this.storage.run(scope, () => dispatch(options)[Symbol.asyncIterator]())
      while (true) {
        const result = await this.storage.run(scope, () => iterator!.next())
        if (result.done === true) return
        yield result.value
      }
    } finally {
      try {
        if (iterator?.return !== undefined) {
          await this.storage.run(scope, () => iterator!.return!())
        }
      } finally {
        scope.accountHash = undefined
        scope.entries.clear()
      }
    }
  }

  private restorePayload(
    scope: ReplayScope,
    payload: unknown,
  ): { readonly payload: Record<string, unknown>; readonly entries: readonly RestoredEntry[] } {
    const body = payloadRecord(payload)
    const input = body.input
    if (!Array.isArray(input)) throw replayError('provider payload has no input array')
    const consumed = new Set<string>()
    const restoredEntries: RestoredEntry[] = []
    const restoredInput: unknown[] = []
    for (const item of input) {
      const marker = exactMarkerItem(item, scope.entries)
      if (marker === undefined) {
        restoredInput.push(item)
        continue
      }
      if (consumed.has(marker)) throw replayError('duplicate checkpoint marker')
      consumed.add(marker)
      const entry = scope.entries.get(marker)
      if (entry === undefined) throw replayError('unknown checkpoint marker')
      const usedNative = this.isCompatible(scope, body, entry.checkpoint)
      const replacementItems: unknown[] = usedNative
        ? entry.checkpoint.replacementItems.map(item => structuredClone(item))
        : [portableUserItem(entry.portableText)]
      restoredEntries.push({
        ...entry,
        usedNative,
        inputIndex: restoredInput.length,
        expectedItems: structuredClone(replacementItems),
      })
      restoredInput.push(...replacementItems)
    }
    if (consumed.size !== scope.entries.size) {
      throw replayError('missing, embedded, or unconsumed checkpoint marker')
    }
    const restored = { ...body, input: restoredInput }
    assertNoMarkers(scope, restored)
    return { payload: restored, entries: restoredEntries }
  }

  private isCompatible(
    scope: ReplayScope,
    payload: Record<string, unknown>,
    checkpoint: CodexNativeCheckpointV1,
  ): boolean {
    if (scope.provider !== CODEX_ROUTE
      || checkpoint.provenance.provider !== scope.provider
      || checkpoint.provenance.model !== scope.model
      || scope.accountHash === undefined
      || checkpoint.provenance.accountHash !== scope.accountHash) return false
    const input = compatibilityInput(scope, scope.accountHash, payload)
    if (input === undefined) return false
    try {
      return checkpoint.compatibilityDigest === codexNativeCheckpointCompatibilityDigest(input)
    } catch {
      return false
    }
  }

  private validateFinalPayload(
    scope: ReplayScope,
    entries: readonly RestoredEntry[],
    payload: unknown,
  ): void {
    if (!isPlainJsonTree(payload, { allowUndefinedObjectProperties: true })) {
      throw invalidFinalPayload()
    }
    const body = payloadRecord(payload)
    if (!Array.isArray(body.input)) throw replayError('final provider payload has no input array')
    assertNoMarkers(scope, body)
    for (const entry of entries) {
      if (!sequenceAt(body.input, entry.inputIndex, entry.expectedItems)) {
        throw replayError('provider callback erased or moved a checkpoint representation')
      }
      if (!entry.usedNative) {
        const nativeArtifact = entry.checkpoint.replacementItems.at(-1)
        if (nativeArtifact !== undefined
          && body.input.some(item => sameNativeArtifact(item, nativeArtifact))) {
          throw replayError('native and Portable checkpoint representations coexist')
        }
        continue
      }
      if (scope.accountHash === undefined) throw replayError('native replay lost account identity')
      const input = compatibilityInput(scope, scope.accountHash, body)
      if (input === undefined
        || codexNativeCheckpointCompatibilityDigest(input) !== entry.checkpoint.compatibilityDigest) {
        throw replayError('provider callback changed native compatibility controls')
      }
      if (body.input.some(item => portableItemContains(item, entry.portableText))) {
        throw replayError('native and Portable checkpoint representations coexist')
      }
    }
  }
}

function textOnlyMessage(message: Message): Message & { readonly role: 'user' } {
  const content = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
  )
  return freezeMessage({ ...message, content }) as Message & { readonly role: 'user' }
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isCompleteBasicCheckpoint(message: Message): boolean {
  const source = message.source
  const sourceRecord = source as unknown as Record<string, unknown>
  if (message.role !== 'user'
    || source.kind !== 'plugin'
    || source.plugin !== 'compact'
    || typeof sourceRecord.compactionId !== 'string') return false
  if (message.content.length < 4
    || message.content.some(block => (
      block.type !== 'text' && block.type !== CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE
    ))) return false
  const first = message.content[0]
  const last = message.content.at(-1)
  if (first?.type !== 'text'
    || sha256Text(first.text) !== BASIC_CHECKPOINT_OPEN_SHA256
    || last?.type !== 'text'
    || sha256Text(last.text) !== BASIC_CHECKPOINT_CLOSE_SHA256) return false
  return message.content.slice(1, -1).some(
    block => block.type === 'text' && block.text.trim().length > 0,
  )
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw replayError('provider payload is not an object')
  return payload
}

function uniqueMarker(
  entries: ReadonlyMap<string, ReplayEntry>,
  reservedText: readonly string[],
): string {
  const entropy = randomUUID()
  let marker = `${MARKER_PREFIX}${entropy}]]`
  let collision = 0
  while (entries.has(marker) || reservedText.some(text => text.includes(marker))) {
    collision += 1
    marker = `${MARKER_PREFIX}${entropy}:${collision}]]`
  }
  return marker
}

function exactMarkerItem(
  item: unknown,
  entries: ReadonlyMap<string, ReplayEntry>,
): string | undefined {
  if (!isRecord(item)
    || !hasOnlyKeys(item, ['role', 'content'])
    || item.role !== 'user'
    || !Array.isArray(item.content)
    || item.content.length !== 1) return undefined
  const content = item.content[0]
  if (!isRecord(content)
    || !hasOnlyKeys(content, ['type', 'text'])
    || content.type !== 'input_text'
    || typeof content.text !== 'string'
    || !entries.has(content.text)) return undefined
  return content.text
}

function portableUserItem(text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'input_text', text }],
  }
}

function sequenceAt(
  input: readonly unknown[],
  start: number,
  expected: readonly unknown[],
): boolean {
  return start >= 0
    && start + expected.length <= input.length
    && expected.every((item, offset) => isDeepStrictEqual(input[start + offset], item))
}

/** The opaque bytes, not forward-extensible metadata, identify native state. */
function sameNativeArtifact(actual: unknown, expected: unknown): boolean {
  return isRecord(actual)
    && isRecord(expected)
    && actual.type === 'compaction'
    && expected.type === 'compaction'
    && typeof expected.encrypted_content === 'string'
    && actual.encrypted_content === expected.encrypted_content
}

function portableItemContains(item: unknown, text: string): boolean {
  if (!isRecord(item) || item.role !== 'user' || text.length === 0) return false
  if (typeof item.content === 'string') return item.content.includes(text)
  if (!Array.isArray(item.content)) return false
  let joined = ''
  for (const content of item.content) {
    if (isRecord(content)
      && content.type === 'input_text'
      && typeof content.text === 'string') joined += content.text
  }
  return joined.includes(text)
}

function compatibilityInput(
  scope: ReplayScope,
  accountHash: string,
  payload: Record<string, unknown>,
): CodexNativeCheckpointCompatibilityInput | undefined {
  if (payload.model !== scope.model
    || typeof payload.instructions !== 'string'
    || typeof payload.parallel_tool_calls !== 'boolean') return undefined
  try {
    return {
      provider: scope.provider,
      model: scope.model,
      accountHash,
      instructions: payload.instructions,
      tools: jsonOrNull(payload.tools),
      parallelToolCalls: payload.parallel_tool_calls,
      toolChoice: jsonOrNull(payload.tool_choice),
      reasoning: jsonOrNull(payload.reasoning),
      text: jsonOrNull(payload.text),
      serviceTier: jsonOrNull(payload.service_tier),
    }
  } catch {
    return undefined
  }
}

function jsonOrNull(value: unknown): JsonValue {
  if (value === undefined) return null
  JSON.stringify(value)
  return value as JsonValue
}

function invalidFinalPayload(): Error {
  return replayError('final provider payload is not a plain JSON-compatible value')
}

function assertNoMarkers(scope: ReplayScope, value: unknown): void {
  if (typeof value === 'string') {
    for (const marker of scope.entries.keys()) {
      if (value.includes(marker)) throw replayError('checkpoint marker leaked into provider payload')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const nested of value) assertNoMarkers(scope, nested)
    return
  }
  if (!isRecord(value)) return
  for (const nested of Object.values(value)) assertNoMarkers(scope, nested)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length
    && allowed.every(key => Object.hasOwn(value, key))
}

function replayError(message: string): Error {
  return new Error(`llm-codex-auth native replay: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

export type { PayloadCallback as CodexProviderPayloadCallback }
