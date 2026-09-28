/** Present Portable checkpoint text to non-Codex adapters that reject custom blocks. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE } from './native-checkpoint.ts'

export function projectForeignCheckpointRequest(options: GenerateOptions): GenerateOptions {
  if (options.provider === 'openai-codex') return options
  let changed = false
  const messages: RequestMessage[] = options.messages.map(message => {
    if (message.role !== 'user' || !message.content.some(block => block.type === CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE)) return message
    changed = true
    return {
      ...message,
      content: message.content.filter(block => block.type !== CODEX_NATIVE_CHECKPOINT_BLOCK_TYPE),
    }
  })
  return changed ? { ...options, messages } : options
}

/** Use the public LLM waterfall; recurse only once with a detached request. */
export function installForeignCheckpointProjection(ctx: Context): () => void {
  return ctx.on('llm/stream', (options, next) => {
    const detached = projectForeignCheckpointRequest(options)
    return detached === options ? next() : ctx.llm.stream(detached)
  }, { prepend: true })
}
