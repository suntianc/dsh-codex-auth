#!/usr/bin/env node
/** Packaged-artifact smoke: exported Host modules, browser bundle, and patch rows. */
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

const DSH_BASELINE = '0.1.0-rc.7'
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
    const entries = Object.entries(manifest[section] ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    if (entries.length === 0) throw new Error(`package smoke: ${section} declares no DSH packages`)
    for (const [name, range] of entries) {
      const parsed = semver.validRange(String(range), SEMVER_OPTIONS)
      const minimum = parsed === null ? null : semver.minVersion(parsed, SEMVER_OPTIONS)
      if (parsed === null
        || minimum === null
        || !semver.satisfies(DSH_BASELINE, parsed, SEMVER_OPTIONS)
        || semver.lt(minimum, DSH_BASELINE)) {
        throw new Error(`package smoke: ${section}.${name} must accept ${DSH_BASELINE} and exclude every earlier version`)
      }
    }
  }
  const lockfile = await readFile(resolve(sourceRoot, 'pnpm-lock.yaml'), 'utf8')
  const dshResolutions = [...lockfile.matchAll(
    /^ {2}['"](@deepseek-ai\/dsh-[^@'"]+)@([^('"\s:]+).*['"]:\s*$/gmu,
  )].map(([, name, version]) => ({ name, version }))
  if (dshResolutions.length === 0) {
    throw new Error('package smoke: pnpm-lock.yaml contains no resolved DSH package entries')
  }
  const staleDshResolutions = dshResolutions.filter(({ version }) => (
    semver.valid(version) === null || semver.lt(version, DSH_BASELINE)
  ))
  if (staleDshResolutions.length > 0) {
    const stale = [...new Set(staleDshResolutions.map(({ name, version }) => `${name}@${version}`))]
    throw new Error(`package smoke: pnpm-lock.yaml resolves DSH below ${DSH_BASELINE}: ${stale.join(', ')}`)
  }
  const hostExports = ['.', './search', './image', './invariant']
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

  console.log(`package smoke: ${filename} exposes Auth/LLM, Search, Image, client, types, and bundle patch`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
