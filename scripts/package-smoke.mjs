#!/usr/bin/env node
/** Packaged-artifact smoke: exported Host modules, browser bundle, and patch rows. */
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

const DSH_BASELINE = '0.1.1-rc.1'
const CODEX_COMPACTION_DSH_VERSION = '0.1.1-rc.2'
const EXPERIMENTAL_DSH_PEERS = [
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-token-meter',
]
const PI_AI_VERSION = '0.82.1'
const SEMVER_OPTIONS = { includePrerelease: true }
const sourceRoot = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(resolve(sourceRoot, '.package-smoke-'))
try {
  const output = execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temporary,
  ], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
  const jsonStart = output.lastIndexOf('\n[')
  const packed = JSON.parse(output.slice(jsonStart < 0 ? 0 : jsonStart + 1))
  const filename = packed?.[0]?.filename
  if (typeof filename !== 'string') throw new Error('package smoke: npm pack returned no artifact')
  execFileSync('tar', ['-xzf', resolve(temporary, filename), '-C', temporary])

  const packageRoot = resolve(temporary, 'package')
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
  const changelog = await readFile(resolve(packageRoot, 'CHANGELOG.md'), 'utf8')
  if (!changelog.includes(`## [${String(manifest.version)}]`)) {
    throw new Error(`package smoke: CHANGELOG.md lacks release ${String(manifest.version)}`)
  }
  for (const section of ['peerDependencies', 'devDependencies']) {
    const required = section === 'peerDependencies'
      ? DSH_BASELINE
      : CODEX_COMPACTION_DSH_VERSION
    const entries = Object.entries(manifest[section] ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-')
        && (section !== 'peerDependencies'
          || !EXPERIMENTAL_DSH_PEERS.includes(name)))
    if (entries.length === 0) throw new Error(`package smoke: ${section} declares no DSH packages`)
    for (const [name, range] of entries) {
      const parsed = semver.validRange(String(range), SEMVER_OPTIONS)
      const minimum = parsed === null ? null : semver.minVersion(parsed, SEMVER_OPTIONS)
      if (parsed === null
        || minimum === null
        || !semver.satisfies(required, parsed, SEMVER_OPTIONS)
        || semver.lt(minimum, required)) {
        throw new Error(`package smoke: ${section}.${name} must accept ${required} and exclude earlier versions`)
      }
    }
  }
  for (const name of EXPERIMENTAL_DSH_PEERS) {
    for (const section of ['peerDependencies', 'devDependencies']) {
      if (manifest[section]?.[name] !== CODEX_COMPACTION_DSH_VERSION) {
        throw new Error(
          `package smoke: ${section}.${name} must pin ${CODEX_COMPACTION_DSH_VERSION}`,
        )
      }
    }
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
      throw new Error(`package smoke: ${name} must remain an optional peer`)
    }
  }
  const piPeerRange = semver.validRange(
    String(manifest.peerDependencies?.['@earendil-works/pi-ai'] ?? ''),
    SEMVER_OPTIONS,
  )
  const piPeerMinimum = piPeerRange === null
    ? null
    : semver.minVersion(piPeerRange, SEMVER_OPTIONS)
  if (piPeerRange === null
    || piPeerMinimum === null
    || !semver.satisfies(PI_AI_VERSION, piPeerRange, SEMVER_OPTIONS)
    || semver.lt(piPeerMinimum, PI_AI_VERSION)) {
    throw new Error(`package smoke: pi-ai peer range must start at ${PI_AI_VERSION}`)
  }
  if (manifest.devDependencies?.['@earendil-works/pi-ai'] !== PI_AI_VERSION) {
    throw new Error(`package smoke: devDependencies must pin pi-ai to ${PI_AI_VERSION}`)
  }
  const lockfile = await readFile(resolve(sourceRoot, 'pnpm-lock.yaml'), 'utf8')
  const dshResolutions = [...lockfile.matchAll(
    /^ {2}['"](@deepseek-ai\/dsh-[^@'"]+)@([^('"\s:]+).*['"]:\s*$/gmu,
  )].map(([, name, version]) => ({ name, version }))
  if (dshResolutions.length === 0) {
    throw new Error('package smoke: pnpm-lock.yaml contains no resolved DSH package entries')
  }
  const declaredDshNames = new Set(['peerDependencies', 'devDependencies']
    .flatMap(section => Object.keys(manifest[section] ?? {}))
    .filter(name => name.startsWith('@deepseek-ai/dsh-')))
  const highestDeclaredDshVersions = new Map()
  for (const { name, version } of dshResolutions) {
    if (!declaredDshNames.has(name) || semver.valid(version) === null) continue
    const current = highestDeclaredDshVersions.get(name)
    if (current === undefined || semver.gt(version, current)) highestDeclaredDshVersions.set(name, version)
  }
  const stale = [...declaredDshNames]
    .filter(name => !highestDeclaredDshVersions.has(name)
      || semver.lt(highestDeclaredDshVersions.get(name), CODEX_COMPACTION_DSH_VERSION))
  if (stale.length > 0) {
    throw new Error(
      `package smoke: pnpm-lock.yaml resolves declared DSH below ${CODEX_COMPACTION_DSH_VERSION}: ${stale.join(', ')}`,
    )
  }
  const hostExports = ['.', './search', './image', './invariant', './compaction']
  for (const key of hostExports) {
    const target = manifest.exports?.[key]?.default
    const types = manifest.exports?.[key]?.types
    if (typeof target !== 'string' || typeof types !== 'string') {
      throw new Error(`package smoke: incomplete export ${key}`)
    }
    const absolute = resolve(packageRoot, target)
    await access(absolute)
    await access(resolve(packageRoot, types))
    const loaded = await import(pathToFileURL(absolute).href)
    if (typeof loaded.apply !== 'function') throw new Error(`package smoke: ${key} has no apply export`)
  }
  const compactionTarget = manifest.exports?.['./compaction']?.default
  const compaction = await import(pathToFileURL(resolve(packageRoot, compactionTarget)).href)
  if (typeof compaction.CodexCompactionEngine !== 'function') {
    throw new Error('package smoke: compaction export has no CodexCompactionEngine')
  }
  if (compaction.CODEX_COMPACTION_COMPATIBILITY?.dsh !== CODEX_COMPACTION_DSH_VERSION
    || compaction.CODEX_COMPACTION_COMPATIBILITY?.piAi !== PI_AI_VERSION) {
    throw new Error('package smoke: compaction export does not advertise the pinned runtime pair')
  }
  compaction.assertCodexCompactionCompatibility()

  const checkpointExport = manifest.exports?.['./native-checkpoint']
  if (typeof checkpointExport?.default !== 'string'
    || typeof checkpointExport?.types !== 'string') {
    throw new Error('package smoke: incomplete native-checkpoint export')
  }
  const checkpointTarget = resolve(packageRoot, checkpointExport.default)
  await access(checkpointTarget)
  await access(resolve(packageRoot, checkpointExport.types))
  const checkpoint = await import(pathToFileURL(checkpointTarget).href)
  if (checkpoint.CODEX_NATIVE_REPLAY_COMPATIBILITY?.dsh !== CODEX_COMPACTION_DSH_VERSION
    || checkpoint.CODEX_NATIVE_REPLAY_COMPATIBILITY?.piAi !== PI_AI_VERSION
    || typeof checkpoint.encodeCodexNativeCheckpoint !== 'function'
    || typeof checkpoint.decodeCodexNativeCheckpoint !== 'function'
    || checkpoint.isCodexNativeReplayRuntimeCompatible() !== true) {
    throw new Error('package smoke: native-checkpoint export lacks its pinned codec/replay contract')
  }

  const presetRoot = resolve(packageRoot, 'examples/agent-presets/codex-portable')
  await access(resolve(presetRoot, 'preset.yml'))
  const preset = await readFile(resolve(presetRoot, 'agent.cordis.yml'), 'utf8')
  if ((preset.match(/name: 'dsh-codex-auth\/compaction'/gu) ?? []).length !== 1) {
    throw new Error('package smoke: custom preset must select exactly one Codex compaction Adapter')
  }
  for (const row of [
    "name: '@deepseek-ai/dsh-command-compact'",
    "name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  ]) {
    if (!preset.includes(row)) throw new Error(`package smoke: custom preset lacks ${row}`)
  }
  if (preset.includes("name: '@deepseek-ai/dsh-compaction-basic'")) {
    throw new Error('package smoke: custom preset also activates compaction-basic')
  }

  const clientTarget = manifest.exports?.['./client']?.default
  const clientTypes = manifest.exports?.['./client']?.types
  if (typeof clientTarget !== 'string' || typeof clientTypes !== 'string') {
    throw new Error('package smoke: incomplete client export')
  }
  await access(resolve(packageRoot, clientTypes))
  const client = await readFile(resolve(packageRoot, clientTarget), 'utf8')
  for (const marker of ['window.__ModuleLoader__.load', 'generate_image', 'list_images', 'codex-search', 'codex-image']) {
    if (!client.includes(marker)) throw new Error(`package smoke: client bundle lacks ${marker}`)
  }
  if (client.includes('require("@deepseek-ai/dsh-client-ui-attachment")')) {
    throw new Error('package smoke: client bundle imports private values from the attachment plugin browser face')
  }

  const patch = await readFile(resolve(packageRoot, manifest.dsh?.bundle?.patch ?? ''), 'utf8')
  for (const row of ['dsh-codex-auth', 'dsh-codex-auth/search', 'dsh-codex-auth/image']) {
    if (!patch.includes(`name: '${row}'`)) throw new Error(`package smoke: patch lacks ${row}`)
  }
  if (!patch.includes('searchProvider: codex')) {
    throw new Error('package smoke: patch does not select Codex globally')
  }
  if (patch.includes('dsh-codex-auth/compaction')) {
    throw new Error('package smoke: default bundle must not activate experimental compaction')
  }

  console.log(`package smoke: ${filename} exposes Host modules, Native replay codec, Portable compaction example, client, types, and unchanged bundle activation`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
