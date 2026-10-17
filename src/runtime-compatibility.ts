/** Each supported DSH graph is verified independently; mixed graphs are never accepted. */
export const SUPPORTED_DSH_RUNTIMES: readonly string[] = Object.freeze([
  '0.2.1-rc.1',
  '0.2.1-rc.2',
])

/** Only the two observed prereleases; future RCs and stable releases need their own verification. */
export const SUPPORTED_DSH_PEER_RANGE = '0.2.1-rc.1 || 0.2.1-rc.2'

export function isSupportedDshGraph(versions: readonly string[]): boolean {
  const version = versions[0]
  return version !== undefined
    && SUPPORTED_DSH_RUNTIMES.includes(version)
    && versions.every(candidate => candidate === version)
}
