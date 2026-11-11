/** Minimal keyed view for one Image Creation tool call. */
import type { ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { CodexImageGallery } from './CodexImageGallery.tsx'
import type { CodexImageLabels, ImageLoader } from './CodexImageGallery.tsx'
import { en, type CodexAuthKey } from './locales.ts'
import classes from './CodexImageToolView.module.css'

export interface CodexImageToolViewProps {
  block: ToolCallBlock
  loadImage: ImageLoader
  t?: (key: CodexAuthKey) => string
}

/** Successful calls render only their durable images; status copy appears only while running or on failure. */
export function CodexImageToolView({ block, loadImage, t = english }: CodexImageToolViewProps): ReactNode {
  if (!('kind' in block)) {
    return <div className={classes.running}><span className={classes.pulse} aria-hidden="true" />{t('toolCreating')}</div>
  }
  if (block.isError) {
    return (
      <div className={classes.failure} role="alert">
        <strong>{t('toolFailed')}</strong>
        <span>{imageFailureMessage(block.error?.code, t)}</span>
      </div>
    )
  }

  const images = block.content.flatMap(content => content.type === 'image'
    ? [{ attachment: content.attachment }]
    : []).slice(0, 10)
  if (images.length === 0) return null

  return <CodexImageGallery images={images} load={loadImage} labels={labels(t)} />
}

function labels(t: (key: CodexAuthKey) => string): CodexImageLabels {
  return {
    image: t('toolGeneratedImage'),
    open: t('toolOpenImage'),
    openNamed: label => `${t('toolOpenImage')}: ${label}`,
    loading: t('toolLoadingImage'),
    loadFailed: t('toolRetryImage'),
    lightbox: { dialog: t('toolImageDialog'), close: t('toolCloseImage') },
  }
}

function english(key: CodexAuthKey): string {
  return en[key]
}

/** Localized explanations for image failures without upstream response text. */
function imageFailureMessage(code: string | undefined, t: (key: CodexAuthKey) => string): string {
  const keys: Record<string, CodexAuthKey> = {
    IMAGE_CANCELLED: 'toolCancelled',
    IMAGE_MODERATION_BLOCKED: 'imageModerationBlocked',
    IMAGE_AUTH_REQUIRED: 'imageAuthRequired',
    IMAGE_ACCESS_DENIED: 'imageAccessDenied',
    IMAGE_REQUEST_REJECTED: 'imageRequestRejected',
    IMAGE_ROUTE_UNAVAILABLE: 'imageRouteUnavailable',
    IMAGE_RATE_LIMITED: 'imageRateLimited',
  }
  const key = code === undefined ? undefined : keys[code]
  return key === undefined ? code ?? t('toolFailed') : t(key)
}
