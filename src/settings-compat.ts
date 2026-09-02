/** Compatibility helpers for DSH settings APIs before and after service ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import * as settingsRuntime from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

interface SettingsSectionHooks<T> {
  setSource(source: () => T): void
  onChange(): void
  validate?(value: T): void
}

type InstallSettingsSection = <T>(
  owner: Context,
  namespace: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
) => void

type SettingsNamespaceFactory = (value: string) => SettingsNamespace

/** Resolve a namespace through the legacy helper when the installed DSH exports it. */
export function compatibleSettingsNamespace(value: string): SettingsNamespace {
  const legacy = (settingsRuntime as { settingsNamespace?: SettingsNamespaceFactory }).settingsNamespace
  return legacy === undefined ? value as SettingsNamespace : legacy(value)
}

/** Install a settings section through the current service or the legacy free function. */
export function installCompatibleSettingsSection<T>(
  ctx: Context,
  namespace: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const provider = ctx.settings as typeof ctx.settings & { installSection?: InstallSettingsSection }
  if (provider.installSection !== undefined) {
    provider.installSection(ctx, namespace, schema, entry, hooks)
    return
  }
  const legacy = (settingsRuntime as { installSettingsSection?: InstallSettingsSection }).installSettingsSection
  if (legacy === undefined) {
    throw new Error('dsh-codex-auth: installed DSH exposes no supported settings-section installer')
  }
  legacy(ctx, namespace, schema, entry, hooks)
}
