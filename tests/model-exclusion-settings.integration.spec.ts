/** Real, temporary profile edits through Settings Forms, Config Editor and Loader. */
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { modelExclusionProfileFixture as profileFixture } from './support/model-exclusion-profile.ts'

vi.mock('../src/env-proxy.ts', () => ({ installEnvHttpProxy: vi.fn() }))

it('persists per-profile exclusions, updates the live catalog without remounting, and restores at restart', async () => {
  const first = profileFixture('first')
  const second = profileFixture('second')
  const ctx = await first.start()
  const other = await second.start()
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'llm-codex-auth')!
  const fiber = entry.fiber
  const all = await ctx.llm.listModels('openai-codex')
  const otherBefore = readFileSync(second.profile.patchPath, 'utf8')
  expect(ctx.settings.describe().find(row => row.ns === 'llm-codex-auth')?.value).toEqual({
    longContextEnabled: false, excludedModelIds: [],
  })
  const changed = vi.fn()
  ctx.on('llm/adapters-updated', changed)
  await ctx.settings.update('llm-codex-auth', { excludedModelIds: ['gpt-5.4', 'unknown', 'gpt-5.4'] })
  expect(entry.fiber).toBe(fiber)
  expect(changed).toHaveBeenCalled()
  expect(await ctx.llm.listModels('openai-codex')).toEqual(all.filter(model => model.id !== 'gpt-5.4'))
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'openai-codex', model: 'gpt-5.4' })
  await expect(ctx.llm.resolveModelInfo('openai-codex', 'gpt-5.4')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  const saved = readFileSync(first.profile.patchPath, 'utf8')
  expect(saved).toContain('excludedModelIds:')
  expect(saved).toContain('gpt-5.4')
  expect(saved).toContain('unknown')
  expect(readFileSync(second.profile.patchPath, 'utf8')).toBe(otherBefore)
  expect(await other.llm.listModels('openai-codex')).toEqual(all)
  const beforeInvalid = saved
  await expect(ctx.settings.update('llm-codex-auth', { excludedModelIds: 'gpt-5.4' })).rejects.toThrow()
  expect(readFileSync(first.profile.patchPath, 'utf8')).toBe(beforeInvalid)
  await ctx.fiber.dispose()
  const restored = await first.start()
  expect(await restored.llm.listModels('openai-codex')).toEqual(all.filter(model => model.id !== 'gpt-5.4'))
  await restored.settings.update('llm-codex-auth', { excludedModelIds: all.map(model => model.id) })
  expect(await restored.llm.listModels('openai-codex')).toEqual([])
  expect(restored.agentDefaultModel.currentSelection().model).toBe('gpt-5.4')
  await restored.settings.update('llm-codex-auth', { excludedModelIds: [], longContextEnabled: true })
  expect(await restored.llm.listModels('openai-codex')).toEqual(all)
  expect((await restored.llm.resolveModelInfo('openai-codex', 'gpt-6-sol')).context?.contextWindow).toBe(872_000)
  expect(await other.llm.listModels('openai-codex')).toEqual(all)
}, 15_000)
