/** Runtime facts must follow the same resolver as the modules actually executing. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { expect, it } from 'vitest'
import { installedPackageVersion } from '../src/package-version.ts'

it('reads the Host-selected package behind a resolver without requiring a package.json export', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-host-version-'))
  const host = join(root, 'host-package')
  mkdirSync(host)
  writeFileSync(join(host, 'package.json'), JSON.stringify({
    name: 'codex-host-version-fixture', version: '1.1.0', type: 'module',
    exports: { '.': { import: './index.js' } },
  }))
  writeFileSync(join(host, 'index.js'), 'export const fixture = true\n')
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === 'codex-host-version-fixture'
      ? { url: pathToFileURL(join(host, 'index.js')).href, shortCircuit: true }
      : nextResolve(specifier, context)
  } })
  try {
    expect(installedPackageVersion('codex-host-version-fixture')).toBe('1.1.0')
  } finally {
    hook.deregister()
    rmSync(root, { recursive: true, force: true })
  }
})

