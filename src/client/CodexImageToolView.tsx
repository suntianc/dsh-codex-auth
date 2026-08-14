/** Keyed durable Image Creation tool result view. */
import type { ReactNode } from 'react'
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageLoader, MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { en, type CodexAuthKey } from './locales.ts'
import classes from './CodexImageToolView.module.css'

interface ToolImage {
  handle: string
  attachment: ImageAttachmentRef
  origin: 'generated' | 'reference' | 'user'
}

interface ToolWarning {
  index: number
  code: string
  message: string
}

export interface CodexImageToolViewProps {
  block: ToolCallBlock
  loadImage: ImageLoader
  t?: (key: CodexAuthKey) => string
}

/** Pure presentation over one running or settled tool-call node. */
export function CodexImageToolView({ block, loadImage, t = english }: CodexImageToolViewProps): ReactNode {
  const imageLabels = labels(t)
  if (!('kind' in block)) {
    return <div className={classes.running}><span className={classes.pulse} aria-hidden="true" />{t('toolCreating')}</div>
  }
  if (block.isError) {
    return (
      <div className={classes.failure} role="alert">
        <strong>{t('toolFailed')}</strong>
        <span>{block.error?.code === 'IMAGE_CANCELLED' ? t('toolCancelled') : block.error?.code ?? t('toolFailed')}</span>
      </div>
    )
  }
  const result = parseToolMeta(block.meta)
  if (result === undefined) {
    return <div className={classes.failure}>{t('toolMetaUnavailable')}</div>
  }
  return (
    <div className={classes.result}>
      <header className={classes.header}>
        <div>
          <span className={classes.eyebrow}>{result.kind === 'catalog' ? t('toolCatalog') : t('toolCreation')}</span>
          <strong>{result.images.length} {t('toolDurableImages')}</strong>
        </div>
        <span className={classes.durable}>{t('toolSavedConversation')}</span>
      </header>

      <ImageGallery
        images={result.images.map(image => ({ attachment: image.attachment }))}
        load={loadImage}
        align="start"
        labels={imageLabels}
      />

      <div className={classes.handles}>
        {result.images.map(image => (
          <div className={classes.imageRow} key={image.handle}>
            <div>
              <code>{image.handle}</code>
              <span>{image.origin}</span>
            </div>
            <button type="button" disabled title={t('workspaceExportUnavailable')}>
              {t('toolSaveWorkspace')}
            </button>
          </div>
        ))}
      </div>

      {result.images.length > 1 ? (
        <button className={classes.saveAll} type="button" disabled title={t('workspaceExportUnavailable')}>
          {t('toolSaveAll')}
        </button>
      ) : null}

      {result.warnings.length === 0 ? null : (
        <ul className={classes.warnings} aria-label={t('toolWarnings')}>
          {result.warnings.map(warning => (
            <li key={`${warning.code}:${String(warning.index)}`}>
              {warning.code} · {t('toolWarningItem')} {warning.index + 1} · {warningText(warning, t)}
            </li>
          ))}
        </ul>
      )}

      <p className={classes.exportNotice}>{t('workspaceExportUnavailable')}</p>
    </div>
  )
}

function warningText(warning: ToolWarning, t: (key: CodexAuthKey) => string): string {
  const key = {
    IMAGE_DATA_MISSING: 'toolWarningDataMissing',
    IMAGE_DATA_TOO_LARGE: 'toolWarningTooLarge',
    IMAGE_DATA_INVALID: 'toolWarningDataInvalid',
    IMAGE_MEDIA_INVALID: 'toolWarningMediaInvalid',
    IMAGE_POLICY_REJECTED: 'toolWarningPolicyRejected',
    IMAGE_STORAGE_FAILED: 'toolWarningStorageFailed',
  }[warning.code] as CodexAuthKey | undefined
  return key === undefined ? warning.message : t(key)
}

function labels(t: (key: CodexAuthKey) => string): MessageImageLabels {
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

function parseToolMeta(value: unknown): { kind: 'generated' | 'catalog'; images: ToolImage[]; warnings: ToolWarning[] } | undefined {
  if (!isRecord(value)) return undefined
  const generated = parseImages(value.images)
  if (generated !== undefined) return {
    kind: 'generated',
    images: generated,
    warnings: parseWarnings(value.warnings),
  }
  const catalog = parseImages(value.items)
  if (catalog !== undefined) return { kind: 'catalog', images: catalog, warnings: [] }
  return undefined
}

function parseImages(value: unknown): ToolImage[] | undefined {
  if (!Array.isArray(value)) return undefined
  const images: ToolImage[] = []
  for (const item of value.slice(0, 10)) {
    if (!isRecord(item)
      || typeof item.handle !== 'string'
      || (item.origin !== 'generated' && item.origin !== 'reference' && item.origin !== 'user')
      || !isImageAttachment(item.attachment)) continue
    images.push({ handle: item.handle, origin: item.origin, attachment: item.attachment })
  }
  return images
}

function parseWarnings(value: unknown): ToolWarning[] {
  if (!Array.isArray(value)) return []
  const warnings: ToolWarning[] = []
  for (const warning of value.slice(0, 10)) {
    if (!isRecord(warning)
      || !Number.isSafeInteger(warning.index)
      || (warning.index as number) < 0
      || typeof warning.code !== 'string'
      || typeof warning.message !== 'string') continue
    warnings.push({ index: warning.index as number, code: warning.code, message: warning.message })
  }
  return warnings
}

function isImageAttachment(value: unknown): value is ImageAttachmentRef {
  return isRecord(value)
    && typeof value.attachmentId === 'string'
    && typeof value.mediaType === 'string'
    && typeof value.bytes === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
