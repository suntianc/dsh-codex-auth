#!/usr/bin/env node
/** Packaged-artifact smoke: exported Host modules, browser bundle, and patch rows. */
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
