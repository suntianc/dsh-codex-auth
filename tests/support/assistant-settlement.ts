import type { AssistantMessage, StreamChunk } from '@deepseek-ai/dsh-llm'

/** A complete provider stream whose settled content survives a v2 restore. */
export function assistantSettlement(message: AssistantMessage) {
  const chunks: StreamChunk[] = message.content.map((block, index) => ({
    type: 'block-end', index, block,
  }))
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return {
    message,
    stream: chunks.map((chunk, index) => ({ type: 'chunk' as const, time: 1_700_000_000_000 + index, chunk })),
  }
}
