/** Completed-turn image artifacts, independent of process-detail disclosure. */
import { useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CodexImageGallery } from './CodexImageGallery.tsx'
import type { ImageLoader } from './CodexImageGallery.tsx'
import { ImageRequestPanel } from './ImageRequestPanel.tsx'
import type { ImageRequestChoices } from './ImageRequestPanel.tsx'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexImageGallery.module.css'

interface ImageTurnState {
  readonly turn: number
  readonly calls: ReadonlySet<string>
  readonly images: readonly ImageAttachmentRef[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Generated outputs owned by this turn; reference inputs are excluded. */
    codexImages: readonly ImageAttachmentRef[]
  }
}

/** Fold durable successful image outputs into the existing turn-artifact extension. */
export const generatedImageDefinition: ConversationNodeDefinition<ImageTurnState> = {
  kind: 'codexImages',
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      if ('surfaceOp' in event && event.surfaceOp !== 'append') return null
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start(_context, match) {
    if (match.event.type !== 'turn/start') throw new Error('Image artifacts require turn/start')
    return { turn: match.event.data.turn, calls: new Set(), images: [] }
  },
  update({ state }, { event }) {
    if (event.type === 'tool/call') {
      if (event.data.name !== 'generate_image') return state
      return { ...state, calls: new Set([...state.calls, String(event.data.callId)]) }
    }
    if (event.type !== 'tool/result' || event.data.message.isError
      || !state.calls.has(String(event.data.message.source.callId))) return state
    const meta = event.data.meta
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || !Array.isArray(meta.images)) return state
    const images = new Map(state.images.map(image => [String(image.attachmentId), image]))
    for (const item of meta.images) {
      if (typeof item !== 'object' || item === null || !('attachment' in item)) continue
      if (isImageReference(item.attachment)) images.set(String(item.attachment.attachmentId), item.attachment)
    }
    return { ...state, images: [...images.values()] }
  },
  buildLocationData({ state }, scope, previous) {
    if (scope !== 'turn' || state === undefined) return null
    if (previous?.kind === 'turn' && previous.key === 'codexImages' && previous.value === state.images) return previous
    return { kind: 'turn', turn: state.turn, key: 'codexImages', value: state.images }
  },
}

function isImageReference(value: unknown): value is ImageAttachmentRef {
  if (typeof value !== 'object' || value === null) return false
  return 'attachmentId' in value && typeof value.attachmentId === 'string'
    && 'mediaType' in value && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mediaType))
    && 'width' in value && typeof value.width === 'number'
    && 'height' in value && typeof value.height === 'number'
    && 'bytes' in value && typeof value.bytes === 'number'
}

/** Display stored images and prepare an explicit edit draft without sending it.
 * @param props Generated outputs, authorized loader, draft action and localized copy.
 * @returns Gallery with one edit action per image, or null for an empty turn.
 */
export function CodexTurnImages({ images, loadImage, editImage, initial, t }: {
  images: readonly ImageAttachmentRef[]
  loadImage: ImageLoader
  editImage: (image: ImageAttachmentRef, prompt: string) => boolean
  initial?: ImageRequestChoices
  t: (key: CodexAuthKey) => string
}) {
  const [editing, setEditing] = useState<string>()
  if (images.length === 0) return null
  return <div className={classes.artifacts}>
    {images.map(image => <div key={String(image.attachmentId)} className={classes.artifact}>
      <div className={classes.previewActions}>
      <CodexImageGallery images={[{ attachment: image }]} load={loadImage} labels={{
        image: t('toolGeneratedImage'), open: t('toolOpenImage'),
        openNamed: label => `${t('toolOpenImage')}: ${label}`,
        loading: t('toolLoadingImage'), loadFailed: t('toolRetryImage'),
        lightbox: { dialog: t('toolImageDialog'), close: t('toolCloseImage') },
      }} />
      <span className={classes.dimensions}>{t('imageActualSize')}: {image.width}×{image.height}</span>
      <button type="button" className={classes.edit} aria-expanded={editing === String(image.attachmentId)}
        onClick={() => { setEditing(editing === String(image.attachmentId) ? undefined : String(image.attachmentId)) }}>{t('editImage')}</button>
      </div>
      {editing === String(image.attachmentId) && <div className={classes.editControls}>
        <ImageRequestPanel image={image} {...initial === undefined ? {} : { initial }}
          prepare={prompt => editImage(image, prompt)} onPrepared={() => { setEditing(undefined) }} t={t} />
      </div>}
    </div>)}
  </div>
}
