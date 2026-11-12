/** Codex SSE transport compatibility for backends that reject zstd request bodies. */
import { zstdDecompressSync } from 'node:zlib'

/**
 * Send pi-ai's compressed SSE body as JSON, preserving the request and response semantics.
 * @param fetchImpl - request-owned HTTP transport, including proxy and cancellation handling.
 * @returns a scoped fetch implementation; non-zstd requests pass through unchanged.
 */
export function codexJsonFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (headers.get('content-encoding') !== 'zstd') return fetchImpl(input, init)
    if (!(init?.body instanceof Uint8Array)) {
      throw new TypeError('Codex zstd request requires a byte buffer')
    }
    const body = zstdDecompressSync(init.body).toString('utf8')
    headers.delete('content-encoding')
    headers.delete('content-length')
    return fetchImpl(input, { ...init, headers, body })
  }
}
