/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageCreateAction } from '../src/client/ImageCreateAction.tsx'
import { ImageRequestPanel } from '../src/client/ImageRequestPanel.tsx'
import { en } from '../src/client/locales.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const image: ImageAttachmentRef = { attachmentId: 'sha256:cat' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 3, width: 1024, height: 1024 }

describe('image request controls', () => {
  it('opens creation controls from the chat and closes after preparing the message', () => {
    const prepare = vi.fn((_prompt: string) => true)
    render(<ImageCreateAction prepare={prepare} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create image' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Describe the image'), { target: { value: 'A kitten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('prepares a new image with explicit per-request model, size and quality', () => {
    const prepare = vi.fn((_prompt: string) => true)
    render(<ImageRequestPanel prepare={prepare} t={t} />)
    fireEvent.change(screen.getByLabelText('Describe the image'), { target: { value: 'A kitten' } })
    fireEvent.change(screen.getByLabelText('Image model'), { target: { value: 'gpt-image-2.5-flare' } })
    fireEvent.click(screen.getByRole('button', { name: '1536×1024' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximum' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('A kitten'))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('gpt-image-2.5-flare'))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('1536x1024'))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('max'))
    expect(prepare.mock.calls[0]?.[0]).not.toContain('image:sha256')
  })

  it('keeps the selected reference for an edit and refuses invalid custom dimensions', () => {
    const prepare = vi.fn((_prompt: string) => true)
    render(<ImageRequestPanel image={image} prepare={prepare} t={t} />)
    fireEvent.change(screen.getByLabelText('Describe the changes'), { target: { value: 'Blue cup' } })
    fireEvent.change(screen.getByLabelText('Custom size'), { target: { value: '256x256' } })
    expect((screen.getByRole('button', { name: 'Add to message' }) as HTMLButtonElement).disabled).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Custom size'), { target: { value: '1536x864' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('image:sha256:cat'))
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('1536x864'))
  })
})
