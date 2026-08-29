import { isPlainRecord, serializedJsonBytes } from './json-tree.ts'
import type { CodexResponsesItem, JsonValue } from './native-checkpoint.ts'

export const CODEX_NATIVE_RETENTION_TOKEN_BUDGET = 64_000
/** Retain newest eligible text-only user groups and one safe boundary prefix. */
export function retainRecentCodexUserMessages(
  inputWithTrigger: readonly JsonValue[],
  budgetTokens = CODEX_NATIVE_RETENTION_TOKEN_BUDGET,
): CodexResponsesItem[] {
  const input = inputWithTrigger.slice(0, -1)
  // This image-free slice admits only user messages, so each Codex history
  // group has one source item and no attached developer image notice.
  const retainedNewestFirst: CodexResponsesItem[] = []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (item === undefined || !isRetainableUserItem(item)) continue
    const cloned = structuredClone(item) as CodexResponsesItem
    if (estimateRetainedTokens([...retainedNewestFirst, cloned]) <= budgetTokens) {
      retainedNewestFirst.push(cloned)
      continue
    }
    const truncated = truncateUserItem(cloned, retainedNewestFirst, budgetTokens)
    if (truncated !== undefined) retainedNewestFirst.push(truncated)
    break
  }
  return retainedNewestFirst.reverse()
}

/** Canonical JSON UTF-8 estimate used for retained text-only items. */
export function estimateCodexJsonTokens(value: unknown): number {
  return Math.ceil(serializedJsonBytes(value) / 4)
}

function estimateRetainedTokens(items: readonly CodexResponsesItem[]): number {
  return items.reduce(
    (total, item) => total + estimateCodexJsonTokens(item),
    0,
  )
}

/**
 * Versioned replay estimate matching Codex's pinned model-visible compaction
 * heuristic: retained items use canonical JSON, while opaque base64 first pays
 * the provider's 650-byte envelope deduction before four-bytes-per-token.
 */
export function estimateCodexReplayTokens(
  retainedItems: readonly CodexResponsesItem[],
  artifact: CodexResponsesItem,
): number {
  const retainedTokens = estimateRetainedTokens(retainedItems)
  const encodedLength = typeof artifact.encrypted_content === 'string'
    ? artifact.encrypted_content.length
    : 0
  const opaqueModelVisibleBytes = Math.max(
    Math.floor(encodedLength * 3 / 4) - 650,
    0,
  )
  return retainedTokens + Math.ceil(opaqueModelVisibleBytes / 4)
}

function truncateUserItem(
  item: CodexResponsesItem,
  newerItems: readonly CodexResponsesItem[],
  budgetTokens: number,
): CodexResponsesItem | undefined {
  if (budgetTokens <= 0) return undefined
  const textLength = typeof item.content === 'string'
    ? item.content.length
    : Array.isArray(item.content)
      ? item.content.reduce<number>((total, part) => total
        + (isPlainRecord(part) && typeof part.text === 'string' ? part.text.length : 0), 0)
      : 0
  if (textLength === 0) return undefined
  let low = 1
  let high = textLength
  let accepted: CodexResponsesItem | undefined
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = retainItemTextPrefix(item, length)
    if (candidate !== undefined
      && estimateRetainedTokens([...newerItems, candidate]) <= budgetTokens) {
      accepted = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return accepted
}

function retainItemTextPrefix(
  item: CodexResponsesItem,
  codeUnits: number,
): CodexResponsesItem | undefined {
  if (typeof item.content === 'string') {
    return { ...item, content: safeUnicodePrefix(item.content, codeUnits) }
  }
  if (!Array.isArray(item.content)) return undefined
  let remaining = codeUnits
  const retained: Record<string, JsonValue>[] = []
  for (const part of item.content) {
    if (remaining <= 0) break
    if (!isPlainRecord(part) || typeof part.text !== 'string') continue
    const text = part.text.length <= remaining
      ? part.text
      : safeUnicodePrefix(part.text, remaining)
    retained.push({ ...(part as Record<string, JsonValue>), text })
    remaining -= Math.min(part.text.length, remaining)
  }
  if (retained.length === 0) return undefined
  return { ...item, content: retained }
}

function safeUnicodePrefix(text: string, codeUnits: number): string {
  let end = Math.min(text.length, codeUnits)
  if (end > 0) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  }
  return text.slice(0, end)
}

function isRetainableUserItem(value: JsonValue): value is CodexResponsesItem {
  if (!isPlainRecord(value)
    || (value.type !== undefined && value.type !== 'message')
    || value.role !== 'user') return false
  if (typeof value.content === 'string') return value.content.length > 0
  return Array.isArray(value.content)
    && value.content.length > 0
    && value.content.every(part => isPlainRecord(part)
      && part.type === 'input_text'
      && typeof part.text === 'string'
      && part.text.length > 0)
}
