/** Each supported DSH graph is verified independently; mixed graphs are never accepted. */
export const SUPPORTED_DSH_RUNTIMES: readonly string[] = Object.freeze([
  '0.1.5-alpha.1',
])

export function isSupportedDshGraph(versions: readonly string[]): boolean {
  const version = versions[0]
  return version !== undefined
    && SUPPORTED_DSH_RUNTIMES.includes(version)
    && versions.every(candidate => candidate === version)
}
