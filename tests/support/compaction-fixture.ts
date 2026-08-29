import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { apply as applyCodexCompaction } from '../../src/compaction.ts'

/** Mount the public dependencies and automatic-disabled custom Adapter for capability regressions. */
export function mountCustomCompaction(ctx: Context): void {
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  applyCodexCompaction(ctx, { auto: false })
}
