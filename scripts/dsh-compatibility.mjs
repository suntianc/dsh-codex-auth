/** The supported npm baseline and matching official source tag. */
export const DSH_BASELINE = '0.1.5-rc.1'
export const DSH_SOURCE_VERSION = '0.1.5-rc.1'
export const DSH_PEER_RANGE = '^0.1.5-rc.1'
export const DSH_EXPERIMENTAL_PEER_RANGE = '0.1.5-rc.1'
export const DSH_VERIFY_VERSION = process.env.DSH_VERIFY_VERSION ?? DSH_BASELINE
if (![DSH_BASELINE, DSH_SOURCE_VERSION].includes(DSH_VERIFY_VERSION)) {
  throw new Error('Unsupported DSH verification version')
}

/** Read version identities from either registry or packed-source pnpm resolutions. */
export function resolvedDshPackages(lockfile) {
  const packages = lockfile.split('\npackages:\n', 2)[1]?.split('\nsnapshots:\n', 1)[0] ?? ''
  return [...packages.matchAll(/^ {2}['"](@deepseek-ai\/dsh-[^@'"]+)@([^'"]+)['"]:\n((?: {4}[^\n]*\n|\n)*)/gmu)]
    .map(([, name, reference, metadata]) => ({
      name,
      version: reference.startsWith('file:')
        ? /^ {4}version: (\S+)$/mu.exec(metadata)?.[1] ?? reference
        : reference,
    }))
}
