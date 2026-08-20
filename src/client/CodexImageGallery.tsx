/** Self-contained durable-image gallery for Codex tool results. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import classes from './CodexImageGallery.module.css'

/** Resolve one session-authorized durable attachment to a browser-owned URL. */
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

/** Copy owned by the Codex capability locale namespace. */
export interface CodexImageLabels {
  image: string
  open: string
  openNamed: (label: string) => string
  loading: string
  loadFailed: string
  lightbox: { dialog: string; close: string }
}

interface GalleryImage {
  attachment: ImageAttachmentRef
}

/** Render durable images without depending on another client plugin's private module exports. */
export function CodexImageGallery({ images, load, labels }: {
  images: readonly GalleryImage[]
  load: ImageLoader
  labels: CodexImageLabels
}): ReactNode {
  if (images.length === 0) return null
  const variant = images.length === 1 ? 'single' : 'tile'
  return (
    <div className={classes.gallery}>
      {images.map((image, index) => (
        <CodexMessageImage
          key={`${String(image.attachment.attachmentId)}:${String(index)}`}
          attachment={image.attachment}
          load={load}
          labels={labels}
          variant={variant}
        />
      ))}
    </div>
  )
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; src: string }
  | { kind: 'failed' }

function CodexMessageImage({ attachment, load, labels, variant }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  labels: CodexImageLabels
  variant: 'single' | 'tile'
}): ReactNode {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [open, setOpen] = useState(false)
  const fit = useMemo(() => variant === 'single' ? singleFit(attachment) : undefined, [attachment, variant])
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])

  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    void load(attachment).then(
      src => { if (live) setState({ kind: 'loaded', src }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false }
  }, [attachment, attempt, load])

  const label = attachment.name ?? labels.image
  if (state.kind === 'failed') {
    return (
      <button className={classes.error} data-variant={variant} type="button" onClick={retry}>
        {labels.loadFailed}
      </button>
    )
  }

  return (
    <>
      <button
        className={classes.frame}
        data-variant={variant}
        type="button"
        style={fit}
        title={labels.open}
        aria-label={labels.openNamed(label)}
        onClick={() => { if (state.kind === 'loaded') setOpen(true) }}
      >
        {state.kind === 'loading'
          ? <span className={classes.loading}>{labels.loading}</span>
          : <img src={state.src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} />}
      </button>
      {open && state.kind === 'loaded'
        ? <CodexImageLightbox src={state.src} alt={label} labels={labels.lightbox} onClose={close} />
        : null}
    </>
  )
}

interface ImageFit extends CSSProperties {
  width: number
  height: number
  objectPosition: string
}

/** Match the stock conversation rule: 240px long edge, bounded aspect ratio, no upscaling. */
function singleFit(attachment: ImageAttachmentRef): ImageFit {
  const width = positiveDimension(attachment.width)
  const height = positiveDimension(attachment.height)
  const natural = width / height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1
    ? { width: 240, height: 240 / ratio }
    : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, width / box.width, height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function CodexImageLightbox({ src, alt, labels, onClose }: {
  src: string
  alt: string
  labels: CodexImageLabels['lightbox']
  onClose: () => void
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div className={classes.backdrop} role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <div className={classes.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={classes.preview} src={src} alt={alt} />
      <button ref={closeRef} className={classes.close} type="button" aria-label={labels.close} onClick={onClose}>
        <span aria-hidden="true">×</span>
      </button>
    </div>,
    document.body,
  )
}
