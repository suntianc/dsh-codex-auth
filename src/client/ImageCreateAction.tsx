/** Main-screen entry to image creation without opening profile settings. */
import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageRequestPanel } from './ImageRequestPanel.tsx'
import type { ImageRequestChoices } from './ImageRequestPanel.tsx'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexUsageFooter.module.css'

/** Open per-request image controls from the blank-session or active composer.
 * @param props Local defaults, draft action and localized copy.
 * @returns Creation trigger and its settings dialog.
 */
export function ImageCreateAction({ prepare, initial, t }: {
  prepare: (prompt: string) => boolean
  initial?: ImageRequestChoices
  t: (key: CodexAuthKey) => string
}) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={classes.pill} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setOpen(true) }}>{t('createImage')}</button>
    <Modal open={open} title={t('createImage')} closeLabel={t('imageClose')} onClose={() => { setOpen(false) }}>
      {open && <ImageRequestPanel {...initial === undefined ? {} : { initial }} prepare={prepare}
        onPrepared={() => { setOpen(false) }} t={t} />}
    </Modal>
  </>
}
