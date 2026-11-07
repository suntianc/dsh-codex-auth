import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { saveSessionFastMode, sessionFastMode, sessionFastModeView } from '../src/codex-session-fast-mode.ts'

it('preserves only this session preference through JSON restore and fork without adding model history', async () => {
  const ctx = new Context()
  const store = new SessionStore(ctx)
  try {
    const first = store.create(SessionId('fast-source'))
    const second = store.create(SessionId('fast-unrelated'))
    expect(sessionFastModeView(first, true)).toEqual({ enabled: true, source: 'profile' })
    saveSessionFastMode(first, false)
    saveSessionFastMode(first, false)
    expect(first.snapshotEvents()).toHaveLength(1)
    expect(sessionFastMode(first)).toBe(false)
    expect(sessionFastMode(second)).toBeUndefined()
    const restored = Session.create(SessionId('fast-restored'), JSON.parse(JSON.stringify(first.snapshotEvents())))
    expect(sessionFastModeView(restored, true)).toEqual({ enabled: false, source: 'session' })
    expect(restored.deriveMessages()).toEqual([])
    const child = store.fork(first, undefined, SessionId('fast-fork'))
    expect(sessionFastMode(child)).toBe(false)
    saveSessionFastMode(child, true)
    expect(sessionFastMode(child)).toBe(true)
    expect(sessionFastMode(first)).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
