/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexUsageFooter } from '../src/client/CodexUsageFooter.tsx'
import type { CodexAuthRpcClient } from '../src/rpc-contract.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en) => en[key]
const subscribe = () => () => {}
const result = (percent: number) => ({ ok: true as const, value: { usage: {
  weeklyRemainingPercent: percent, weeklyResetAt: '2026-11-08T12:00:00Z',
} } })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('refreshes live quota, clears unavailable data, and cancels a pending probe on unmount', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const usage = vi.fn().mockResolvedValueOnce(result(49)).mockResolvedValueOnce({ ok: true, value: { usage: {} } })
    .mockImplementationOnce((next: AbortSignal) => { signal = next; return new Promise(() => {}) })
  const { unmount } = render(<CodexUsageFooter rpc={{ usage } as unknown as CodexAuthRpcClient} t={t} subscribe={subscribe} />)
  await act(async () => {})
  expect(screen.getByText('Codex · Week 49%').title).toContain('Week resets:')
  expect(screen.queryByText(/5h/)).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(screen.queryByText(/49%/)).toBeNull()
  fireEvent.click(screen.getByText('Codex · limits unavailable'))
  await act(async () => {})
  expect(usage).toHaveBeenCalledTimes(3)
  unmount()
  expect(signal?.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(usage).toHaveBeenCalledTimes(3)
})

it('invalidates account data on reconnect and ignores the older request that finishes late', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof result>>()
  let reset = () => {}
  const onReset = (listener: () => void) => { reset = listener; return () => {} }
  const usage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result(20))
  render(<CodexUsageFooter rpc={{ usage } as unknown as CodexAuthRpcClient} t={t} subscribe={onReset} />)
  act(() => reset())
  expect(await screen.findByText('Codex · Week 20%')).toBeTruthy()
  await act(async () => { pending.resolve(result(99)) })
  expect(screen.queryByText(/99%/)).toBeNull()
})

it('persists Fast for the displayed conversation without touching the next conversation', async () => {
  const fastMode = vi.fn(async (id: string, enabled?: boolean) => ({ ok: true as const, value: {
    fastMode: { enabled: enabled ?? id === 'session-a', source: 'session' as const },
  } }))
  const rpc = { usage: vi.fn(async () => result(49)), fastMode } as unknown as CodexAuthRpcClient
  const { rerender } = render(<CodexUsageFooter rpc={rpc} t={t} subscribe={subscribe} sessionId="session-a" />)
  const toggle = await screen.findByRole('switch', { name: /Fast/ })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await act(async () => {})
  expect(fastMode).toHaveBeenCalledWith('session-a', false, expect.any(AbortSignal))
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  rerender(<CodexUsageFooter rpc={rpc} t={t} subscribe={subscribe} sessionId="session-b" />)
  await act(async () => {})
  expect(fastMode).toHaveBeenCalledWith('session-b', undefined, expect.any(AbortSignal))
  expect(screen.getByRole('switch', { name: /Fast/ }).getAttribute('aria-checked')).toBe('false')
})
