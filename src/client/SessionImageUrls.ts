/** Bounded browser-owned Blob URLs over session-authorized attachment reads. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

interface CacheEntry {
  promise: Promise<string>
  url?: string
}

/** Owns only this plugin's image URLs; clearing never evicts conversation-owned URLs. */
export class SessionImageUrls {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly sessions: Pick<ISessions, 'binding'>,
    private readonly maxEntries = 32,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
  }

  resolve(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    const key = JSON.stringify([String(sessionId), String(attachment.attachmentId)])
    const cached = this.entries.get(key)
    if (cached !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.promise
    }

    let pending: Promise<string>
    pending = this.read(sessionId, attachment).then(
      (url) => {
        const current = this.entries.get(key)
        if (current?.promise !== pending) {
          URL.revokeObjectURL(url)
          throw new Error('Image URL request became stale')
        }
        current.url = url
        return url
      },
      (error: unknown) => {
        if (this.entries.get(key)?.promise === pending) this.entries.delete(key)
        throw error
      },
    )
    this.entries.set(key, { promise: pending })
    this.evictOverflow()
    return pending
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.url !== undefined) URL.revokeObjectURL(entry.url)
    }
    this.entries.clear()
  }

  private async read(sessionId: SessionId, expected: ImageAttachmentRef): Promise<string> {
    const session = this.sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error('The image session is no longer available')
    const result = await session.readAttachment(expected.attachmentId)
    if (!result.ok) throw new Error(result.error.message || 'The session did not authorize this image')
    if (result.value.attachment.attachmentId !== expected.attachmentId) {
      throw new Error('The authorized image response did not match the requested attachment')
    }
    const bytes = new Uint8Array(result.value.data.byteLength)
    bytes.set(result.value.data)
    return URL.createObjectURL(new Blob([bytes], { type: result.value.attachment.mediaType }))
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined
      if (oldest === undefined) return
      this.entries.delete(oldest[0])
      if (oldest[1].url !== undefined) URL.revokeObjectURL(oldest[1].url)
    }
  }
}
