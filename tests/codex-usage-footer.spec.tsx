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

it('opens an informative dialog without clearing quota or triggering a new probe', async () => {
  const usage = vi.fn(async () => result(49))
  render(<CodexUsageFooter rpc={{ usage } as unknown as CodexAuthRpcClient} t={t} subscribe={subscribe} />)
  fireEvent.click(await screen.findByText('Codex · Week 49%'))
  const dialog = await screen.findByRole('dialog', { name: 'Codex subscription limits' })
  expect(dialog.textContent).toContain('Weekly allowance')
  expect(dialog.textContent).toContain('Five-hour allowance')
  expect(dialog.textContent).toContain('Not reported by this account')
  expect(dialog.textContent).toContain('Last checked')
  expect(dialog.textContent).toContain(new Date('2026-11-08T12:00:00Z').toLocaleString())
  expect(screen.getByText('Codex · Week 49%')).toBeTruthy()
  expect(usage).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a labeled last-known snapshot during refresh and failure, and cancels on unmount', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<ReturnType<typeof result>>()
  let signal: AbortSignal | undefined
  const usage = vi.fn().mockResolvedValueOnce(result(49)).mockReturnValueOnce(pending.promise)
    .mockImplementationOnce((next: AbortSignal) => { signal = next; return new Promise(() => {}) })
  const { unmount } = render(<CodexUsageFooter rpc={{ usage } as unknown as CodexAuthRpcClient} t={t} subscribe={subscribe} />)
  await act(async () => {})
  fireEvent.click(screen.getByText('Codex · Week 49%'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh limits' }))
  await act(async () => {})
  expect(screen.getByText('Codex · Week 49%')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Refreshing…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { pending.resolve({ ok: true, value: { usage: {} } } as ReturnType<typeof result>) })
  expect(screen.getByText('Codex · Week 49% · stale')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Last known values')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh limits' }))
  await act(async () => {})
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

it('explains initially unavailable limits and recovers through the dialog refresh button', async () => {
  const usage = vi.fn().mockResolvedValueOnce({ ok: true, value: { usage: {} } }).mockResolvedValueOnce({ ok: true, value: { usage: {
    planType: 'promax', weeklyRemainingPercent: 86, fiveHourRemainingPercent: 70,
  } } })
  render(<CodexUsageFooter rpc={{ usage } as unknown as CodexAuthRpcClient} t={t} subscribe={subscribe} />)
  await act(async () => {})
  fireEvent.click(screen.getByText('Codex · limits unavailable'))
  expect(screen.getByRole('status').textContent).toContain('Limits are currently unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh limits' }))
  expect(await screen.findByText('Codex · 5h 70% · Week 86%')).toBeTruthy()
  expect(screen.getByText('Pro Max')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Five-hour allowance' }).textContent).toContain('70%')
  expect(screen.queryByRole('status')).toBeNull()
})
