#!/usr/bin/env node
/** Validate this plugin against packed, built packages from the official source tag. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DSH_SOURCE_VERSION } from './dsh-compatibility.mjs'

const sourceRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2).filter(value => value !== '--')
if (args.length !== 1) {
  throw new Error('Usage: pnpm run check:dsh-source -- /path/to/packed-dsh-packages (see docs/dsh-source-verification.md)')
}
const packageDirectory = resolve(args[0])
const packages = new Map()
for (const filename of (await readdir(packageDirectory)).filter(name => name.endsWith('.tgz'))) {
  const path = join(packageDirectory, filename)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
  if (!manifest.name.startsWith('@deepseek-ai/')) continue
  if (manifest.name.startsWith('@deepseek-ai/dsh-') && manifest.version !== DSH_SOURCE_VERSION) {
    throw new Error('Mixed source package version: ' + manifest.name + '@' + manifest.version)
  }
  if (packages.has(manifest.name)) throw new Error('Duplicate source package: ' + manifest.name)
  packages.set(manifest.name, {
    path, manifest,
    integrity: 'sha512-' + createHash('sha512').update(await readFile(path)).digest('base64'),
  })
}
const stage = await mkdtemp(join(tmpdir(), basename(sourceRoot) + '-dsh-source-'))
const checkout = join(stage, basename(sourceRoot))
await cp(sourceRoot, checkout, {
  recursive: true,
  filter: path => !['.git', 'node_modules', 'lib', 'coverage'].includes(basename(path))
    && !basename(path).endsWith('.tgz') && !basename(path).startsWith('.package-smoke-'),
})
const manifestPath = join(checkout, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const pending = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies })
const selected = new Map()
while (pending.length) {
  const name = pending.pop()
  if (selected.has(name)) continue
  const artifact = packages.get(name)
  if (!artifact) {
    if (name.startsWith('@deepseek-ai/dsh-')) throw new Error('Missing source artifact: ' + name)
    continue
  }
  selected.set(name, artifact)
  manifest.devDependencies[name] = artifact.manifest.version
  pending.push(...Object.keys(artifact.manifest.dependencies ?? {}), ...Object.keys(artifact.manifest.peerDependencies ?? {}))
}
if (![...selected.keys()].some(name => name.startsWith('@deepseek-ai/dsh-'))) {
  throw new Error('No DSH source dependencies selected')
}
const artifactDirectory = join(stage, 'packages')
await mkdir(artifactDirectory)
const overrides = {}
const receipt = []
for (const [name, artifact] of selected) {
  const destination = join(artifactDirectory, basename(artifact.path))
  await cp(artifact.path, destination)
  overrides[name] = 'file:' + destination
  receipt.push({ name, version: artifact.manifest.version, integrity: artifact.integrity })
}
if (manifest.devDependencies['@earendil-works/pi-ai']) {
  overrides['@earendil-works/pi-ai'] = manifest.devDependencies['@earendil-works/pi-ai']
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
const workspacePath = join(checkout, 'pnpm-workspace.yaml')
const workspace = (await readFile(workspacePath, 'utf8')).replace(/^autoInstallPeers:.*\n/gmu, '')
if (/^overrides:/mu.test(workspace)) throw new Error('Source verification requires reviewing existing overrides')
await writeFile(workspacePath, workspace + '\nautoInstallPeers: true\noverrides:\n'
  + Object.entries(overrides).map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value)).join('\n') + '\n')
await writeFile(join(stage, 'artifacts.json'), JSON.stringify({
  target: DSH_SOURCE_VERSION,
  expectedSourceCommit: '183f08e9c6dde7e36cd2318eaee70b0da08fb35e',
  // The build recipe establishes provenance. These checksums identify the supplied bytes.
  packages: receipt,
}, null, 2) + '\n')
const env = { ...process.env, DSH_VERIFY_VERSION: DSH_SOURCE_VERSION }
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: checkout, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('pnpm ' + args.join(' ') + ' failed; evidence: ' + stage)
}
console.log('Source verification stage: ' + stage)
run(['install', '--no-frozen-lockfile', '--ignore-scripts'])
run(['peers', 'check'])
run(['run', 'check'])
console.log('Source verification passed: ' + stage)
