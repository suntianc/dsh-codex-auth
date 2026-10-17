import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'

/** Resolve an installed package version without importing a private subpath. */
export function installedPackageVersion(specifier: string): string {
  try {
    // Resolve through the Host's loader first: findPackageJSON(bare, base) ignores custom resolvers.
    const packagePath = findPackageJSON(import.meta.resolve(specifier))
    if (packagePath === undefined) return 'unresolved'
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unreadable'
  } catch {
    return 'unreadable'
  }
}
