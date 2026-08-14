/** Shared bounded UTF-8 response reader for private Codex capability endpoints. */
export interface BoundedResponseErrors {
  tooLarge: () => Error
  cancelled?: () => Error
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  errors: BoundedResponseErrors,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response)
    throw errors.tooLarge()
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted === true && errors.cancelled !== undefined) throw errors.cancelled()
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw errors.tooLarge()
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (signal?.aborted === true && errors.cancelled !== undefined) throw errors.cancelled()
    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* discard best-effort */ }
}
