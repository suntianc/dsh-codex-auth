/** Per-request image controls shared by creation and editing surfaces. */
import { useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGE_MODELS, IMAGE_QUALITIES, isImageSize, supportsImageQuality, supportsImageSize } from '../image-options.ts'
import type { ImageQuality } from '../image-options.ts'
import type { CodexAuthKey } from './locales.ts'
import classes from './ImageRequestPanel.module.css'

/** Local choices embedded in one visible user request, without saving profile settings. */
export interface ImageRequestChoices {
  model: string
  size: string
  quality: ImageQuality
}

const PRESETS = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '3840x2160'] as const
const QUALITY_LABELS = { auto: 'automatic', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'maxQuality' } as const

/** Build an explicit image request in the main composer, preserving the user's send decision.
 * @param props Optional source image, initial choices, draft preparation and localized copy.
 * @returns Model, size, quality and description controls.
 */
export function ImageRequestPanel({ image, initial, prepare, onPrepared, t }: {
  image?: ImageAttachmentRef
  initial?: ImageRequestChoices
  prepare: (prompt: string) => boolean
  onPrepared?: () => void
  t: (key: CodexAuthKey) => string
}) {
  const [model, setModel] = useState(initial?.model ?? 'gpt-image-2.5-sunburst')
  const [size, setSize] = useState(initial?.size ?? 'auto')
  const [quality, setQuality] = useState<ImageQuality>(initial?.quality ?? 'auto')
  const [description, setDescription] = useState('')
  const [failed, setFailed] = useState(false)
  const validSize = isImageSize(size) && supportsImageSize(model, size)
  const validQuality = supportsImageQuality(model, quality)
  const submit = (): void => {
    if (!validSize || !validQuality || description.trim() === '') return
    const prompt = [
      image === undefined ? t('createImagePrompt') : t('editImagePrompt') + `image:${String(image.attachmentId)}`,
      description.trim(),
      `${t('imageModel')}: ${model}`,
      `${t('imageResolution')}: ${size}`,
      `${t('imageQuality')}: ${quality}`,
    ].join('\n')
    const accepted = prepare(prompt)
    setFailed(!accepted)
    if (accepted) onPrepared?.()
  }
  return <div className={classes.panel}>
    <label className={classes.field}>{t('imageModel')}
      <select value={model} onChange={event => { setModel(event.target.value) }}>
        {!IMAGE_MODELS.some(candidate => candidate === model) && <option value={model}>{model}</option>}
        {IMAGE_MODELS.map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
      </select>
    </label>
    <fieldset className={classes.group}>
      <legend>{t('imageResolution')}</legend>
      <div className={classes.choices}>{PRESETS.map(preset => <button type="button" key={preset}
        aria-pressed={size === preset} disabled={!supportsImageSize(model, preset)}
        onClick={() => { setSize(preset) }}>{preset === 'auto' ? t('automatic') : preset.replace('x', '×')}</button>)}</div>
      <label className={classes.field}>{t('imageCustomSize')}
        <input value={size} onChange={event => { setSize(event.target.value.trim()) }} />
      </label>
      {!validSize && <p role="alert" className={classes.hint}>{t('invalidImageSize')}</p>}
    </fieldset>
    <fieldset className={classes.group}>
      <legend>{t('imageQuality')}</legend>
      <div className={classes.choices}>{IMAGE_QUALITIES.map(value => <button type="button" key={value}
        aria-pressed={quality === value} disabled={!supportsImageQuality(model, value)}
        onClick={() => { setQuality(value) }}>{t(QUALITY_LABELS[value])}</button>)}</div>
      {!validQuality && <p role="alert" className={classes.hint}>{t('invalidImageQuality')}</p>}
    </fieldset>
    <label className={classes.field}>{t(image === undefined ? 'imageDescription' : 'imageChanges')}
      <textarea rows={3} value={description} onChange={event => { setDescription(event.target.value) }} />
    </label>
    <p className={classes.hint}>{t('imageRequestHint')}</p>
    {failed && <p role="alert">{t('editImageFailed')}</p>}
    <button type="button" className={classes.primary} disabled={!validSize || !validQuality || description.trim() === ''}
      onClick={submit}>{t('imageAddToMessage')}</button>
  </div>
}
