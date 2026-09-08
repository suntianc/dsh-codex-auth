import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyCodex, type Config } from '../src/index.ts'
import { ACCOUNT_COMMAND_DENIED_MESSAGE } from '../src/loopback-rpc.ts'

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
 * Mount apply() on a real Cordis context in one Host composition.
 * `connection` composes the `connection` service; `webServer` composes a
 * WebServer inside it. A terminal profile composes neither.
 */
async function mountComposition(options: { connection?: boolean; webServer?: string }): Promise<CommandDefinition> {
  const ctx = new Context()
  contexts.push(ctx)
  let registered: CommandDefinition | undefined
  ctx.provide('commands', {
    register(definition: unknown) {
      registered = definition as CommandDefinition
      return () => undefined
    },
  })
  ctx.provide('settings', { installSection: vi.fn() })
  if (options.connection) {
    ctx.provide('connection', { rpc: { handle: vi.fn(() => vi.fn()) } })
  }
  if (options.webServer !== undefined) {
    ctx.provide('webServer', { host: options.webServer })
  }
  applyCodex(ctx, codexConfig())
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(registered).toBeDefined()
  return registered!
}

/** The codex service rejects login before spawning when its CLI is not on PATH. */
const CLI_UNAVAILABLE = 'definitely-not-codex") is not on PATH'

describe('codex-auth command registration/dispatch boundary', () => {
  it('registers the slash command on a loopback-bound Web composition', async () => {
    const registered = await mountComposition({ connection: true, webServer: '127.0.0.1' })
    expect(registered.name).toBe('codex-auth')
  })

  it.each(['status', 'login'])('reaches the shared auth service for %s on a loopback-bound Web composition', async operation => {
    const registered = await mountComposition({ connection: true, webServer: '127.0.0.1' })
    const result = await registered.handler({ rawInput: operation } as never)

    expect(result.kind === 'error' ? (result as { text: string }).text : '').not.toBe(ACCOUNT_COMMAND_DENIED_MESSAGE)
    if (operation === 'login') {
      expect((result as { text: string }).text).toContain(CLI_UNAVAILABLE)
    } else {
      expect((result as { text: string }).text).toContain('Codex auth:')
    }
  })

  it('denies every operation on a public (non-loopback) Web bind without reaching the auth service', async () => {
    const registered = await mountComposition({ connection: true, webServer: '0.0.0.0' })

    for (const rawInput of ['', 'status', 'login']) {
      await expect(registered.handler({ rawInput } as never)).resolves.toEqual({
        kind: 'error',
        text: ACCOUNT_COMMAND_DENIED_MESSAGE,
      })
    }
  })

  it('denies every operation when a WebServer is composed on an unknown bind', async () => {
    const registered = await mountComposition({ connection: true, webServer: '' })
    for (const rawInput of ['status', 'login']) {
      await expect(registered.handler({ rawInput } as never)).resolves.toEqual({
        kind: 'error',
        text: ACCOUNT_COMMAND_DENIED_MESSAGE,
      })
    }
  })

  it.each(['status', 'login'])('reaches the shared auth service for %s on a connection-only terminal composition', async operation => {
    const registered = await mountComposition({ connection: true })

    const result = await registered.handler({ rawInput: operation } as never)
    expect(result.kind === 'error' ? (result as { text: string }).text : '').not.toBe(ACCOUNT_COMMAND_DENIED_MESSAGE)
    if (operation === 'login') {
      expect((result as { text: string }).text).toContain(CLI_UNAVAILABLE)
    } else {
      expect((result as { text: string }).text).toContain('Codex auth:')
    }
  })

  it.each(['status', 'login'])('reaches the shared auth service for %s on a terminal composition without WebServer/connection', async operation => {
    const registered = await mountComposition({})

    const result = await registered.handler({ rawInput: operation } as never)
    expect(result.kind === 'error' ? (result as { text: string }).text : '').not.toBe(ACCOUNT_COMMAND_DENIED_MESSAGE)
    if (operation === 'login') {
      expect((result as { text: string }).text).toContain(CLI_UNAVAILABLE)
    } else {
      expect((result as { text: string }).text).toContain('Codex auth:')
    }
  })
})
