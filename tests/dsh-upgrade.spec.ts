/** Offline profile admission and durable V4 continuation across the verified DSH 0.2.1 RC graphs. */
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
const previousRelease = JSON.parse(readFileSync(
  new URL('./fixtures/dsh-codex-auth-0.3.3-rc.4-manifest.json', import.meta.url), 'utf8',
)) as {
  producer: { sourceCommit: string; sourcePath: string }; manifest: typeof manifest
}
const targetRuntime = getDshRuntimeVersion()
const exactPeers = ['@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-token-meter']

const singleRcRelease = JSON.parse(readFileSync(
  new URL('./fixtures/dsh-codex-auth-0.3.4-rc.1-manifest.json', import.meta.url), 'utf8',
)) as { manifest: typeof manifest }

function profileFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-021rc1-profile-'))
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

it('disables released 0.3.3-rc.4 on the verified runtime despite an old exact-version exemption', () => {
  const fixture = profileFixture()
  const previous = previousRelease.manifest
  expect(previousRelease.producer).toEqual({
    sourceCommit: '8756d4dd04ddb18b492cc0c0d12453a35095b018',
    sourcePath: 'package.json',
    description: 'Unmodified admission fields from the released 0.3.3-rc.4 source manifest.',
  })
  expect(previous).toMatchObject({ name: 'dsh-codex-auth', version: '0.3.3-rc.4' })
  expect(evaluatePluginCompatibility(previous, {}, '0.2.0-rc.2')).toBeUndefined()
  const issue = evaluatePluginCompatibility(previous, {}, targetRuntime)
  expect(Object.keys(issue?.requirements ?? {}).sort()).toEqual([...exactPeers].sort())
  expect(issue).toMatchObject({
    name: previous.name, version: previous.version, runtimeVersion: targetRuntime, exempted: false,
  })
  writeFileSync(join(fixture.packageDir, 'package.json'), JSON.stringify(previous))
  const permissions = JSON.stringify({ [`${previous.name}@${previous.version}`]: ['0.2.0-rc.2'] })
  writeFileSync(join(fixture.dir, 'compatibility.json'), permissions)
  const exemptions = readProfileCompatibility(fixture.dir).exemptions
  expect(evaluatePluginCompatibility(previous, exemptions, targetRuntime)?.exempted).toBe(false)
  expect(prepareProfileEntries(fixture.ctx, fixture.rows, fixture.base).map(row => row.disabled))
    .toEqual([true, true, true])
  expect(fixture.diagnostics).toHaveBeenCalledTimes(3)
  expect(fixture.rows.every(row => row.disabled === undefined)).toBe(true)
  expect(readFileSync(join(fixture.dir, 'compatibility.json'), 'utf8')).toBe(permissions)
})

it('admits all adapted bundle rows without a grant or rewriting synthetic settings and login state', async () => {
  const fixture = profileFixture()
  expect(['0.2.1-rc.1', '0.2.1-rc.2']).toContain(targetRuntime)
  writeFileSync(join(fixture.packageDir, 'package.json'), JSON.stringify(manifest))
  const files = {
    'settings.yaml': 'codex-llm:\n  longContextEnabled: true\n',
    'cordis.patch.yml': '- id: llm-codex-auth\n  config:\n    transport: sse\n',
    'auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', account_id: 'synthetic-account',
    }, future_field: 'preserved' }),
  }
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(fixture.dir, name), contents)
  expect(manifest.version).not.toBe(previousRelease.manifest.version)
  expect(evaluatePluginCompatibility(manifest, {}, targetRuntime)).toBeUndefined()
  expect(evaluatePluginCompatibility(manifest)).toBeUndefined()
  expect(readProfileCompatibility(fixture.dir).exemptions).toEqual({})
  expect(prepareProfileEntries(fixture.ctx, fixture.rows, fixture.base)).toEqual(fixture.rows)
  expect(fixture.diagnostics).not.toHaveBeenCalled()
  expect((await readAuthFile(join(fixture.dir, 'auth.json')))?.tokens?.account_id).toBe('synthetic-account')
  for (const [name, contents] of Object.entries(files)) {
    expect(readFileSync(join(fixture.dir, name), 'utf8')).toBe(contents)
  }
})

it.each([
  { version: '0.2.0-rc.1', portable: 'RC.1 PORTABLE CHECKPOINT' },
  { version: '0.2.0-rc.2', portable: 'RC.2 PORTABLE CHECKPOINT' },
])('restores, forks, and continues a $version V4 Dual Checkpoint without rewriting native state', async ({ version, portable }) => {
  const fixtureUrl = new URL(`./fixtures/dsh-${version}-session.json`, import.meta.url)
  const durable = readFileSync(fixtureUrl, 'utf8')
  const fixture = JSON.parse(durable) as {
    producer: { dsh: string; synthetic: boolean }; id: string; events: SessionEvent[];
    header: Parameters<typeof Session.fromRestore>[2]; inheritedEventCount: number
  }
  expect(fixture.producer).toMatchObject({ dsh: version, synthetic: true })
  const originalEvents = JSON.stringify(fixture.events)
  const originalNative = fixture.events.flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .find(block => block.type === 'codex-native-checkpoint')
  expect(originalNative).toBeDefined()
  if (originalNative?.type !== 'codex-native-checkpoint') throw new Error('Fixture has no native checkpoint')
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
  expect(native).toEqual(originalNative)
  if (native?.type !== 'codex-native-checkpoint') throw new Error('Restored session has no native checkpoint')
  expect(native.state).toBe(originalNative.state)
  expect(decodeCodexNativeCheckpoint(native).ok).toBe(true)
  const fork = ctx.sessions.fork(restored, undefined, SessionId(`synthetic-021rc1-fork-${version}`))
  fork.append('turn/start', { turn: 2 })
  fork.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Continue on ${targetRuntime}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  fork.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(fork.deriveMessages().flatMap(message => message.content)).toContainEqual(native)
  expect(JSON.stringify(fork.deriveMessages())).toContain(portable)
  expect(JSON.stringify(fork.deriveMessages())).toContain(`Continue on ${targetRuntime}`)
  const persistedFork = JSON.parse(JSON.stringify({
    events: fork.snapshotEvents(), header: fork.header, inheritedEventCount: fork.inheritedEventCount,
  })) as {
    events: SessionEvent[]; header: typeof fork.header; inheritedEventCount: typeof fork.inheritedEventCount
  }
  const restoredFork = Session.fromRestore(fork.id, persistedFork.events, persistedFork.header,
    persistedFork.inheritedEventCount, 'detached')
  const restoredForkNative = restoredFork.deriveMessages().flatMap(message => message.content)
    .find(block => block.type === 'codex-native-checkpoint')
  expect(restoredForkNative).toEqual(originalNative)
  if (restoredForkNative?.type !== 'codex-native-checkpoint') throw new Error('Restored fork has no native checkpoint')
  expect(restoredForkNative.state).toBe(originalNative.state)
  expect(restored.snapshotEvents()).toEqual(restoredEvents)
  expect(JSON.stringify(fixture.events)).toBe(originalEvents)
  expect(readFileSync(fixtureUrl, 'utf8')).toBe(durable)
})


it('reproduces the published single-RC installation rejection and accepts both verified RCs', () => {
  expect(evaluatePluginCompatibility(singleRcRelease.manifest, {}, '0.2.1-rc.1')).toBeUndefined()
  const rejected = evaluatePluginCompatibility(singleRcRelease.manifest, {}, '0.2.1-rc.2')
  expect(Object.keys(rejected?.requirements ?? {}).sort()).toEqual([...exactPeers].sort())
  expect(rejected?.exempted).toBe(false)
  for (const runtime of ['0.2.1-rc.1', '0.2.1-rc.2']) {
    expect(evaluatePluginCompatibility(manifest, {}, runtime)).toBeUndefined()
  }
})

it.each(['0.2.1-rc.0', '0.2.1-rc.1.1', '0.2.1-rc.2.1', '0.2.1-rc.3', '0.2.1', '0.2.2-rc.1', '0.3.0'])('does not admit unverified %s through prerelease range semantics', runtime => {
  const rejected = evaluatePluginCompatibility(manifest, {}, runtime)
  expect(rejected).toBeDefined()
  expect(rejected?.exempted).toBe(false)
})
