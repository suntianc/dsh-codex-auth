/** @vitest-environment jsdom */
/** Exercise the settings page against a real temporary profile, without account RPC. */
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CodexCapabilitySettings, type LlmSettingsView } from '../src/client/CodexCapabilitySettings.tsx'
import { en } from '../src/client/locales.ts'
import { modelExclusionProfileFixture } from './support/model-exclusion-profile.ts'

vi.mock('../src/env-proxy.ts', () => ({ installEnvHttpProxy: vi.fn() }))

it('saves and clears model exclusions from the page into an isolated profile and live catalog', async () => {
  const fixture = modelExclusionProfileFixture('settings-page')
  const ctx = await fixture.start()
  onTestFinished(cleanup)
  const listeners = new Set<() => void>()
  const read = (): ConfigFormSnapshot<LlmSettingsView> => ({
    status: 'ready', value: ctx.settings.describe().find(row => row.ns === 'llm-codex-auth')!.value as LlmSettingsView,
    writable: ctx.settings.writable, base: {}, user: {}, revision: 1,
  })
  let snapshot = read()
  const publish = () => { snapshot = read(); for (const listener of listeners) listener() }
  const llmScope: ConfigForm<LlmSettingsView> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => { await ctx.settings.update('llm-codex-auth', { [field]: value }); publish(); return true },
    unset: async field => { await ctx.settings.mutate('llm-codex-auth', [{ op: 'unset', path: [field] }]); publish(); return true },
    mutate: async ops => { await ctx.settings.mutate('llm-codex-auth', ops); publish(); return true },
  }
  const unavailable = <T,>(): ConfigForm<T> => {
    const value: ConfigFormSnapshot<T> = { status: 'unavailable', value: undefined, writable: false, base: {}, user: {}, revision: 1 }
    return { getSnapshot: () => value, subscribe: () => () => {}, set: async () => false, unset: async () => false, mutate: async () => false }
  }
  render(<CodexCapabilitySettings
    rpc={{
      status: async () => ({ ok: true, value: { status: { available: false, configured: false, authFileExists: false, credentialRef: 'synthetic' } } }),
      usage: async () => ({ ok: true, value: { usage: {} } }),
      login: async () => { throw new Error('Account operations are forbidden in this test') },
    }}
    t={key => en[key]} subscribe={() => () => {}} llmScope={llmScope} searchScope={unavailable()} imageScope={unavailable()}
  />)
  const all = await ctx.llm.listModels('openai-codex')
  expect(all.some(model => model.id === 'gpt-6-sol')).toBe(true)
  expect(all.some(model => model.id === 'gpt-6-luna')).toBe(true)
  const field = screen.getByLabelText(en.excludedModelIds) as HTMLInputElement
  fireEvent.change(field, { target: { value: 'gpt-6-sol, gpt-6-luna' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await waitFor(() => expect(snapshot.value?.excludedModelIds).toEqual(['gpt-6-sol', 'gpt-6-luna']))
  expect(readFileSync(fixture.profile.patchPath, 'utf8')).toContain('excludedModelIds:')
  expect(await ctx.llm.listModels('openai-codex')).toEqual(all.filter(model => !['gpt-6-sol', 'gpt-6-luna'].includes(model.id)))
  await waitFor(() => expect(field.disabled).toBe(false))
  fireEvent.change(field, { target: { value: '' } })
  fireEvent.blur(field)
  await waitFor(() => expect(snapshot.value?.excludedModelIds).toEqual([]))
  expect(await ctx.llm.listModels('openai-codex')).toEqual(all)
}, 15_000)
