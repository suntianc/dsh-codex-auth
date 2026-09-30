/** Offline profile admission and V4 continuation across the DSH rc.1 → rc.2 upgrade. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  evaluatePluginCompatibility, getDshRuntimeVersion, prepareProfileEntries,
  readProfileCompatibility, type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readAuthFile } from '../src/codex-auth.ts'
import { decodeCodexNativeCheckpoint } from '../src/native-checkpoint.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string; version: string; peerDependencies: Record<string, string>
}
const exactPeers = ['@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-token-meter']

function profileFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rc2-profile-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const profile: ProfileContext = {
    name: 'synthetic-upgrade', dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(dir, 'package.json'), cwd: dir, home: dir,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  const packageDir = join(dir, 'node_modules', manifest.name)
  mkdirSync(packageDir, { recursive: true })
  const rows: EntryOptions[] = [
    { id: 'llm-codex-auth', name: 'dsh-codex-auth' },
    { id: 'codex-search', name: 'dsh-codex-auth/search' },
    { id: 'codex-image', name: 'dsh-codex-auth/image' },
  ]
  const diagnostics = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  onTestFinished(() => diagnostics.mockRestore())
  return { dir, ctx, rows, packageDir, diagnostics, base: pathToFileURL(profile.installAnchor).href }
}

it('disables the released rc.1 bundle on rc.2 despite an old exact-version exemption', () => {
  const fixture = profileFixture()
  const previous = {
    ...manifest,
    peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies).map(([name, range]) =>
      [name, range.replace('0.2.0-rc.2', '0.2.0-rc.1')],
    )),
  }
  expect(evaluatePluginCompatibility(previous, {}, '0.2.0-rc.1')).toBeUndefined()
  const issue = evaluatePluginCompatibility(previous, {}, '0.2.0-rc.2')
  expect(Object.keys(issue?.peers ?? {}).sort()).toEqual([...exactPeers].sort())
  writeFileSync(join(fixture.packageDir, 'package.json'), JSON.stringify(previous))
  const permissions = JSON.stringify({ [`${manifest.name}@${manifest.version}`]: ['0.2.0-rc.1'] })
  writeFileSync(join(fixture.dir, 'compatibility.json'), permissions)
  const exemptions = readProfileCompatibility(fixture.dir).exemptions
  expect(evaluatePluginCompatibility(previous, exemptions, '0.2.0-rc.2')?.exempted).toBe(false)
  expect(prepareProfileEntries(fixture.ctx, fixture.rows, fixture.base).map(row => row.disabled))
    .toEqual([true, true, true])
  expect(fixture.diagnostics).toHaveBeenCalledTimes(3)
  expect(fixture.rows.every(row => row.disabled === undefined)).toBe(true)
  expect(readFileSync(join(fixture.dir, 'compatibility.json'), 'utf8')).toBe(permissions)
})

it('admits all adapted bundle rows without a grant or rewriting synthetic settings and login state', async () => {
  const fixture = profileFixture()
  expect(getDshRuntimeVersion()).toBe('0.2.0-rc.2')
  writeFileSync(join(fixture.packageDir, 'package.json'), JSON.stringify(manifest))
  const files = {
    'settings.yaml': 'codex-llm:\n  longContextEnabled: true\n',
    'cordis.patch.yml': '- id: llm-codex-auth\n  config:\n    transport: sse\n',
    'auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account_id: 'synthetic-account',
    }, future_field: 'preserved' }),
  }
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(fixture.dir, name), contents)
  expect(evaluatePluginCompatibility(manifest)).toBeUndefined()
  expect(readProfileCompatibility(fixture.dir).exemptions).toEqual({})
  expect(prepareProfileEntries(fixture.ctx, fixture.rows, fixture.base)).toEqual(fixture.rows)
  expect(fixture.diagnostics).not.toHaveBeenCalled()
  expect((await readAuthFile(join(fixture.dir, 'auth.json')))?.tokens?.account_id).toBe('synthetic-account')
  for (const [name, contents] of Object.entries(files)) {
    expect(readFileSync(join(fixture.dir, name), 'utf8')).toBe(contents)
  }
})

it('restores, forks, and continues an rc.1-produced V4 Dual Checkpoint without rewriting its native state', async () => {
  const durable = readFileSync(new URL('./fixtures/dsh-0.2.0-rc.1-session.json', import.meta.url), 'utf8')
  const fixture = JSON.parse(durable) as {
    producer: { dsh: string; synthetic: boolean }; id: string; events: SessionEvent[];
    header: Parameters<typeof Session.fromRestore>[2]; inheritedEventCount: number
  }
  expect(fixture.producer).toMatchObject({ dsh: '0.2.0-rc.1', synthetic: true })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const restored = Session.fromRestore(SessionId(fixture.id), fixture.events, fixture.header,
    SessionLogOffset(fixture.inheritedEventCount), 'detached')
  expect(restored.header.version).toBe(4)
  expect(restored.snapshotEvents().slice(0, fixture.events.length)).toEqual(fixture.events)
  expect(restored.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
  const detach = ctx.sessions.enter(restored)
  onTestFinished(detach)
  ctx.sessions.announce(restored)
  const restoredEvents = restored.snapshotEvents()
  const native = restored.deriveMessages().flatMap(message => message.content)
    .find(block => block.type === 'codex-native-checkpoint')
  expect(native).toBeDefined()
  if (native === undefined) throw new Error('Fixture has no native checkpoint')
  expect(decodeCodexNativeCheckpoint(native).ok).toBe(true)
  const fork = ctx.sessions.fork(restored, undefined, SessionId('synthetic-rc2-fork'))
  fork.append('turn/start', { turn: 2 })
  fork.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Continue on RC.2' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  fork.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(fork.deriveMessages().flatMap(message => message.content)).toContainEqual(native)
  expect(JSON.stringify(fork.deriveMessages())).toContain('RC.1 PORTABLE CHECKPOINT')
  expect(JSON.stringify(fork.deriveMessages())).toContain('Continue on RC.2')
  expect(restored.snapshotEvents()).toEqual(restoredEvents)
})
