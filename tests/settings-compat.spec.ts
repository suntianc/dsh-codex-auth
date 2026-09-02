import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'

const legacy = vi.hoisted(() => ({
  install: vi.fn(),
  namespace: vi.fn((value: string) => value),
}))

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: legacy.install,
  settingsNamespace: legacy.namespace,
}))

const { compatibleSettingsNamespace, installCompatibleSettingsSection } = await import('../src/settings-compat.ts')

describe('settings API compatibility', () => {
  it('uses the legacy namespace factory when the installed DSH exports it', () => {
    expect(compatibleSettingsNamespace('codex-llm')).toBe('codex-llm')
    expect(legacy.namespace).toHaveBeenCalledWith('codex-llm')
  })

  it('prefers the current settings service installer', () => {
    const installSection = vi.fn()
    const ctx = { settings: { installSection } } as unknown as Context
    const schema = z.object({ enabled: z.boolean() })
    const entry = { enabled: true }
    const hooks = { setSource: vi.fn(), onChange: vi.fn() }

    installCompatibleSettingsSection(ctx, compatibleSettingsNamespace('codex-search'), schema, entry, hooks)

    expect(installSection).toHaveBeenCalledWith(ctx, 'codex-search', schema, entry, hooks)
    expect(legacy.install).not.toHaveBeenCalled()
  })

  it('falls back to the legacy settings installer', () => {
    const ctx = { settings: {} } as unknown as Context
    const schema = z.object({ enabled: z.boolean() })
    const entry = { enabled: true }
    const hooks = { setSource: vi.fn(), onChange: vi.fn() }

    installCompatibleSettingsSection(ctx, compatibleSettingsNamespace('codex-image'), schema, entry, hooks)

    expect(legacy.install).toHaveBeenCalledWith(ctx, 'codex-image', schema, entry, hooks)
  })
})
