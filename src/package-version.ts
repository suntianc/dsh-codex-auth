import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'

/** Resolve an installed package version without importing a private subpath. */
export function installedPackageVersion(specifier: string, from: string): string {
  try {
    const packagePath = findPackageJSON(specifier, from)
    if (packagePath === undefined) return 'unresolved'
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unreadable'
  } catch {
    return 'unreadable'
  }
}
