import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyCodex, type Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
})

function codexConfig(): Config {
  return {
    llmEnabled: false,
    authJsonPath: '/nonexistent/auth.json',
    credentialRef: 'CODEX_CHATGPT_TOKEN',
    refreshLeadMs: 5 * 60 * 1000,
    codexCommand: 'definitely-not-codex',
    displayName: 'OpenAI Codex (chatgpt)',
    longContextEnabled: false,
    transport: 'sse',
    websocketConnectTimeoutMs: 3000,
    timeoutMs: 60000,
  }
}

/**
 * Mount a real Cordis composition for the intended terminal profile: real
 * SessionStore + CommandRuntime, the plugin applied, and NO WebServer or
 * `connection` service. Commands dispatch through the real command runtime.
 */
async function mountTerminal(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  applyCodex(ctx, codexConfig())
  await new Promise<void>(resolve => setImmediate(resolve))
  const session = ctx.sessions.create(SessionId('codex-auth-terminal'))
  const agent = { id: session.id, session } as unknown as Agent
  return { ctx, agent }
}

/** The codex service rejects login before spawning when its CLI is not on PATH. */
const CLI_UNAVAILABLE = 'definitely-not-codex") is not on PATH'

describe('codex-auth slash command on a terminal composition (no WebServer/connection)', () => {
  it('dispatches status through the real command runtime to the shared auth service', async () => {
    const { ctx, agent } = await mountTerminal()

    const execution = await ctx.commands.execute(agent, '/codex-auth status', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    if (execution?.result.kind === 'success') {
      expect(execution.result.text).toContain('Codex auth:')
      expect(execution.result.text).not.toContain('require a local DSH Host')
    }
  })

  it('dispatches login through the real command runtime into the shared auth service', async () => {
    const { ctx, agent } = await mountTerminal()

    const execution = await ctx.commands.execute(agent, '/codex-auth login', [], new AbortController().signal)

    // The denial gate is disabled on this composition, so the handler reached
    // the shared service, which rejects because its CLI is not installed.
    expect(execution?.result.kind).toBe('error')
    if (execution?.result.kind === 'error') {
      expect(execution.result.text).toContain(CLI_UNAVAILABLE)
    }
  })
})
