// @vitest-environment jsdom
/** Captured ImageBlock rendering regression for the generate_image tool view. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexImageToolView } from '../src/client/CodexImageToolView.tsx'

const imageName = 'generated-1786724195-1.png'
const attachment: ImageAttachmentRef = {
  attachmentId: 'sha256:9d7f49d312fbc9ed57431af9fd4dfc67d0b1c5c075fafb573e0d28d8d3aa49e9' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  width: 1254,
  height: 1254,
  bytes: 807603,
  name: imageName,
}

const block: ToolResultNode = {
  kind: 'tool-result',
  seq: 119,
  time: 1786724195670,
  callId: 'call-generate-image',
  call: { name: 'generate_image', argsRaw: '{"prompt":"blue background with white circle","n":1}' },
  callTime: 1786724169821,
  content: [
    { type: 'text', text: `Created 1 durable image(s): image:${String(attachment.attachmentId)}.` },
    { type: 'image', attachment },
  ],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CodexImageToolView', () => {
  it('renders the durable image carried by a captured successful tool result', async () => {
    const loadImage = vi.fn(async () => 'blob:captured-image')

    render(<CodexImageToolView block={block} loadImage={loadImage} />)

    expect((await screen.findByRole('img', { name: imageName })).getAttribute('src')).toBe('blob:captured-image')
    expect(loadImage).toHaveBeenCalledWith(attachment)
  })
})
