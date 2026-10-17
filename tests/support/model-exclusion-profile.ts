/** Synthetic profile composition shared by Host and settings-page regressions. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings from '@deepseek-ai/dsh-settings'
import { onTestFinished } from 'vitest'
import * as CodexPlugin from '../../src/index.ts'

// Resolve Config Editor's public export through Settings' existing dependency.
const require = createRequire(import.meta.url)
const settingsRequire = createRequire(require.resolve('@deepseek-ai/dsh-settings'))
const { default: ConfigEditor } = await import(pathToFileURL(settingsRequire.resolve('@deepseek-ai/dsh-config-editor')).href)

export function modelExclusionProfileFixture(name: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-model-exclusion-')))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', name)
  initProfile(dir, ['synthetic-codex-bundle'])
  const bundle = join(dir, 'node_modules', 'synthetic-codex-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"synthetic-codex-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'synthetic-codex-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm', name: 'cordis:llm' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'default-model', name: 'cordis:model', config: { provider: 'openai-codex', model: 'gpt-6-sol' } },
    { id: 'llm-codex-auth', name: 'cordis:codex', config: {
      authJsonPath: join(dir, 'never-created-auth.json'), codexCommand: 'definitely-not-codex',
    } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name, dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    home, cwd: home, startedBundles: ['synthetic-codex-bundle'], overlays: [], telemetryDisabledEnv: undefined,
  }
  const start = async () => {
    const ctx = await boot('synthetic-codex', join(dir, 'cordis.yml'), readProfilePatches('synthetic-codex', profile), ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { llm: LlmRuntime, editor: ConfigEditor, settings: Settings, model: DefaultModel, codex: CodexPlugin })
    })
    onTestFinished(async () => { await ctx.fiber.dispose() })
    return ctx
  }
  return { profile, start }
}
