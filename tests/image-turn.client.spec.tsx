/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CodexTurnImages, generatedImageDefinition } from '../src/client/CodexTurnImages.tsx'
import { en } from '../src/client/locales.ts'

const image: ImageAttachmentRef = { attachmentId: 'sha256:cat' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 3, width: 1024, height: 1024, name: 'cat.png' }
afterEach(cleanup)

describe('generated image turn artifacts', () => {
  it('shows the image outside process details and prepares an edit for that exact image', async () => {
    const edit = vi.fn(() => true)
    render(<CodexTurnImages images={[image]} loadImage={async () => 'blob:cat'} editImage={edit} t={key => en[key]} />)
    expect(await screen.findByRole('img', { name: 'cat.png' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
    expect(edit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Describe the changes'), { target: { value: 'Blue cup' } })
    fireEvent.click(screen.getByRole('button', { name: '1536×1024' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(edit).toHaveBeenCalledWith(image, expect.stringContaining('image:sha256:cat'))
    expect(edit).toHaveBeenCalledWith(image, expect.stringContaining('1536x1024'))
  })

  it('reports refusal to prepare a draft', () => {
    render(<CodexTurnImages images={[image]} loadImage={async () => 'blob:cat'} editImage={() => false} t={key => en[key]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
    fireEvent.change(screen.getByLabelText('Describe the changes'), { target: { value: 'Blue cup' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(screen.getByRole('alert').textContent).toContain('draft')
  })

  it('accumulates successful generation results but excludes failed calls and reference images', () => {
    const start = generatedImageDefinition.start({} as never, { event: { type: 'turn/start', data: { turn: 1 } } } as never, {} as never)
    const publication = generatedImageDefinition.buildLocationData?.({ state: start } as never, 'turn', null)
    expect(publication?.key).toBe(generatedImageDefinition.kind)
    const called = generatedImageDefinition.update({ state: start } as never, { event: { type: 'tool/call', data: { name: 'generate_image', callId: 'call' } } } as never)
    const event = { type: 'tool/result', data: { message: { source: { callId: 'call' }, isError: false }, meta: { images: [{ attachment: image }], references: [{ attachment: { ...image, name: 'reference.png' } }] } } }
    const done = generatedImageDefinition.update({ state: called } as never, { event } as never)
    expect(done.images).toEqual([image])
    expect(generatedImageDefinition.update({ state: called } as never, { event: { ...event, data: { ...event.data, message: { ...event.data.message, isError: true } } } } as never).images).toEqual([])
  })
})
