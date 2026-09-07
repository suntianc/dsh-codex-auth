import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Mount apply() with a real Context whose connection inject reports `host`. */
async function applyWithWebServerHost(host: string | undefined) {
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
  ctx.provide('connection', { rpc: { handle: vi.fn(() => vi.fn()) } })
  ctx.provide('webServer', host === undefined ? {} : { host })
  applyCodex(ctx, codexConfig())
  await new Promise<void>(resolve => setImmediate(resolve))
  return { registered }
}

describe('codex-auth command dispatch boundary', () => {
  it('registers the slash command under the account-control loopback policy', async () => {
    const { registered } = await applyWithWebServerHost('127.0.0.1')
    expect(registered).toBeDefined()
    expect(registered!.name).toBe('codex-auth')
  })

  it('denies login through the slash command on a non-loopback bind without reaching the auth service', async () => {
    const { registered } = await applyWithWebServerHost('0.0.0.0')
    expect(registered).toBeDefined()

    await expect(registered!.handler({ rawInput: 'login' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'Codex account controls require a loopback-bound DSH Host',
    })
  })

  it('denies every operation through the slash command when no WebServer is composed', async () => {
    const { registered } = await applyWithWebServerHost(undefined)

    await expect(registered!.handler({ rawInput: '' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'Codex account controls require a loopback-bound DSH Host',
    })
    await expect(registered!.handler({ rawInput: 'status' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'Codex account controls require a loopback-bound DSH Host',
    })
  })
})
