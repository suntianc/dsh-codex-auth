/** Session Fast uses the existing live writer without claiming a routed child Agent. */
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import { sessionFastMode } from '../src/codex-session-fast-mode.ts'

vi.mock('../src/env-proxy.ts', () => ({ installEnvHttpProxy: vi.fn() }))

it('reads and persists Fast on a live routed child without resolving or replacing its Agent', async () => {
  const ctx = new Context()
  try {
    ctx.provide('credentials', {
      modifyRecord: async (_key: unknown, update: (current: undefined) => Promise<CredentialRecord>) => update(undefined),
    } as unknown as CredentialProvider)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(Connection)
    await ctx.plugin(SessionStore)
    const parent = ctx.sessions.create(SessionId('fast-parent'))
    const child = ctx.sessions.create(SessionId('fast-owned-child'), [], {
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
    })
    // Generic SessionController routing deliberately rejects subagent-owned identities.
    const resolveAgent = vi.fn(async () => ({ error: new Error('owned by subagent routing') }))
    ctx.provide('sessionController', { resolveAgent })
    const flushed: SessionId[] = []
    ctx.on('session/flush', session => { flushed.push(session.id) })
    const config: Config = {
      llmEnabled: false, authJsonPath: '/nonexistent/fast-rpc-auth.json',
      credentialRef: 'CODEX_CHATGPT_TOKEN', refreshLeadMs: 300_000,
      codexCommand: 'definitely-not-codex', displayName: 'OpenAI Codex (chatgpt)',
      longContextEnabled: false, fastModeEnabled: false, transport: 'sse',
      websocketConnectTimeoutMs: 3000, timeoutMs: 60_000,
    }
    apply(ctx, config)
    await new Promise<void>(resolve => setImmediate(resolve))
    const connection = ctx.connection
    if (!(connection instanceof Connection.HostConnectionService)) throw new Error('Expected real Host Connection')
    const handler = connection.createSharedFetchHandler('/api')
    const request = async (enabled?: boolean) => {
      const response = await handler.fetch(new Request('http://127.0.0.1/api/codex-auth/fast-mode', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fast-child-test', method: 'codex-auth/fast-mode',
          payload: { sessionId: child.id, ...enabled === undefined ? {} : { enabled } } }),
      }), connection.browserPeer)
      expect(response.status).toBe(200)
      return await response.json()
    }
    expect(await request()).toMatchObject({ result: { ok: true, value: { fastMode: { enabled: false, source: 'profile' } } } })
    expect(flushed).toEqual([])
    expect(await request(true)).toMatchObject({ result: { ok: true, value: { fastMode: { enabled: true, source: 'session' } } } })
    expect(await request()).toMatchObject({ result: { ok: true, value: { fastMode: { enabled: true, source: 'session' } } } })
    expect(flushed).toEqual([child.id])
    expect(sessionFastMode(child)).toBe(true)
    expect(sessionFastMode(parent)).toBeUndefined()
    expect(ctx.sessions.get(child.id)).toBe(child)
    expect(child.deriveMessages()).toEqual([])
    expect(resolveAgent).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
})
