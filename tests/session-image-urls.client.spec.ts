import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionImageUrls } from '../src/client/SessionImageUrls.ts'

const attachment = (id: string): ImageAttachmentRef => ({
  attachmentId: id as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: `${id}.png`,
})

const sessionId = (id: string): SessionId => id as SessionId

afterEach(() => vi.restoreAllMocks())

describe('SessionImageUrls', () => {
  it('coalesces authorized reads and revokes only its own bounded URLs', async () => {
    let url = 0
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${String(++url)}`)
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const readAttachment = vi.fn(async (id: ImageAttachmentRef['attachmentId']) => ({
      ok: true as const,
      value: { attachment: attachment(String(id)), data: new Uint8Array([1, 2, 3]) },
    }))
    const sessions = {
      binding: vi.fn(() => ({ session: { readAttachment } })),
    } as unknown as Pick<ISessions, 'binding'>
    const images = new SessionImageUrls(sessions, 1)

    await expect(Promise.all([
      images.resolve(sessionId('session-a'), attachment('one')),
      images.resolve(sessionId('session-a'), attachment('one')),
    ])).resolves.toEqual(['blob:1', 'blob:1'])
    expect(readAttachment).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)

    await expect(images.resolve(sessionId('session-b'), attachment('one'))).resolves.toBe('blob:2')
    expect(readAttachment).toHaveBeenCalledTimes(2)
    expect(sessions.binding).toHaveBeenNthCalledWith(1, sessionId('session-a'))
    expect(sessions.binding).toHaveBeenNthCalledWith(2, sessionId('session-b'))
    expect(revoke).toHaveBeenCalledWith('blob:1')

    images.clear()
    expect(revoke).toHaveBeenCalledWith('blob:2')
  })

  it('fails closed when the session cannot authorize the attachment', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const sessions = {
      binding: vi.fn(() => ({ session: {
        readAttachment: vi.fn(async () => ({
          ok: false as const,
          error: { code: 'ATTACHMENT_NOT_REFERENCED', message: 'not referenced' },
        })),
      } })),
    } as unknown as Pick<ISessions, 'binding'>
    const images = new SessionImageUrls(sessions)

    await expect(images.resolve(sessionId('session-a'), attachment('foreign'))).rejects.toThrow('not referenced')
    expect(create).not.toHaveBeenCalled()
  })
})
