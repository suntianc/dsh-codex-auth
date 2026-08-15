// @vitest-environment jsdom
/** Browser regressions for the GPT Auth settings card. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAuthCard } from '../src/client/CodexAuthCard.tsx'
import type { CodexAuthCardInjected } from '../src/client/CodexAuthCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: CodexAuthCardInjected['t'] = key => en[key]

/** Mount the card around one scripted status call. */
function mountWithStatus(status: CodexAuthCardInjected['rpc']['status']): void {
  render(<CodexAuthCard
    rpc={{ status, usage: vi.fn(async () => ({ ok: true as const, value: { usage: {} } })), login: vi.fn() }}
    t={t}
    subscribe={() => () => {}}
  />)
}

describe('CodexAuthCard transport state', () => {
  it('settles to an explicit error when the status transport rejects', async () => {
    mountWithStatus(() => Promise.reject(new Error('HTTP 404: codex auth channel unavailable')))

    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 404')
    await waitFor(() => { expect(screen.queryByText(en.refreshing)).toBeNull() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.refresh }).disabled).toBe(false)
  })
})
