import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { assertCodexCompactionCompatibility } from '../src/compaction.ts'
import { isCodexNativeReplayRuntimeCompatible } from '../src/native-checkpoint.ts'

it('reproduces the released 0.3.4-rc.2 refusal after a Harness 0.2.2 update', () => {
  const { manifest } = JSON.parse(readFileSync(
    new URL('./fixtures/dsh-codex-auth-0.3.4-rc.2-manifest.json', import.meta.url), 'utf8',
  ))
  expect(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2')).toBeUndefined()
  const issue = evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1')
  expect(issue?.exempted).toBe(false)
  expect(Object.keys(issue?.requirements ?? {}).sort()).toEqual([
    '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-token-meter',
  ])
})

it('admits the bundle on DSH 0.2.2-rc.1 without a compatibility exemption', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1')).toBeUndefined()
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.2-rc.1.1', '0.2.2-rc.2', '0.2.2']) {
    expect(evaluatePluginCompatibility(manifest, {}, version)?.exempted).toBe(false)
  }
})

it('accepts the 0.2.2 converter with pi-ai 1.3.0 and rejects crossed converter pairs', () => {
  expect(isCodexNativeReplayRuntimeCompatible({
    dshLlm: '0.2.2-rc.1', dshPiAi: '0.2.2-rc.1', piAi: '1.3.0',
  })).toBe(true)
  for (const [dshLlm, dshPiAi, piAi] of [
    ['0.2.2-rc.1', '0.2.2-rc.1', '1.1.0'],
    ['0.2.1-rc.2', '0.2.1-rc.2', '1.3.0'],
    ['0.2.2-rc.1', '0.2.1-rc.2', '1.3.0'],
    ['0.2.2-rc.1', '0.2.2-rc.1', '1.3.1'],
  ] as const) {
    expect(isCodexNativeReplayRuntimeCompatible({ dshLlm, dshPiAi, piAi })).toBe(false)
  }
})

it('mounts experimental compaction only on a coherent 0.2.2 and pi-ai 1.3.0 graph', () => {
  const dsh = {
    '@deepseek-ai/dsh-agent': '0.2.2-rc.1',
    '@deepseek-ai/dsh-compaction': '0.2.2-rc.1',
    '@deepseek-ai/dsh-compaction-basic': '0.2.2-rc.1',
    '@deepseek-ai/dsh-llm': '0.2.2-rc.1',
    '@deepseek-ai/dsh-llm-pi-ai': '0.2.2-rc.1',
    '@deepseek-ai/dsh-session': '0.2.2-rc.1',
    '@deepseek-ai/dsh-token-meter': '0.2.2-rc.1',
  }
  expect(() => assertCodexCompactionCompatibility({ dsh, piAi: '1.3.0' })).not.toThrow()
  expect(() => assertCodexCompactionCompatibility({ dsh, piAi: '1.1.0' })).toThrow()
  for (const name of Object.keys(dsh)) {
    expect(() => assertCodexCompactionCompatibility({
      dsh: { ...dsh, [name]: '0.2.1-rc.2' }, piAi: '1.3.0',
    })).toThrow()
  }
})
