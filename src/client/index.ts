/** Browser half of the Codex Capability Bundle. */
import { createElement, useCallback } from 'react'
import type { ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createCodexAuthRpcClient } from '../rpc-contract.ts'
import { CodexCapabilitySettings } from './CodexCapabilitySettings.tsx'
import type {
  CodexCapabilitySettingsProps, ImageSettingsView, LlmSettingsView, SearchSettingsView,
} from './CodexCapabilitySettings.tsx'
import { CodexImageToolView } from './CodexImageToolView.tsx'
import { en, zh, type CodexAuthKey } from './locales.ts'
import { SessionImageUrls } from './SessionImageUrls.ts'

export { CodexCapabilitySettings } from './CodexCapabilitySettings.tsx'
export type {
  CodexCapabilitySettingsProps, ImageSettingsView, LlmSettingsView, SearchSettingsView,
} from './CodexCapabilitySettings.tsx'
export { CodexImageToolView } from './CodexImageToolView.tsx'
export type { CodexImageToolViewProps } from './CodexImageToolView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the unified GPT Auth section. */
    'settings.codexAuth': CodexAuthKey
  }
}

const NS = 'settings.codexAuth'
const LLM_ENTRY_ID = 'llm-codex-auth'
const SEARCH_ENTRY_ID = 'codex-search'
const IMAGE_ENTRY_ID = 'codex-image'

/** Required browser services, including session-authorized attachment reads. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms', 'sessions']

/** Register the four-card settings section and keyed image result renderers. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-capabilities: copy dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const sessions = (ctx as unknown as { sessions: ISessions }).sessions
  const imageUrls = new SessionImageUrls(sessions)
  ctx.effect(() => () => { imageUrls.clear() }, 'codex-capabilities: image URL cleanup')
  const reset = (): void => {
    imageUrls.clear()
    for (const listener of listeners) listener()
  }
  ctx.effect(() => ctx.on('connection/reset', reset), 'codex-capabilities: connection invalidation')

  if (connection.isLoopback) {
    const rpc = createCodexAuthRpcClient(connection.rpc)
    const t = ctx.locale.bind(NS) as CodexCapabilitySettingsProps['t']
    const llmScope = ctx.configForms.get<LlmSettingsView>(LLM_ENTRY_ID)
    const searchScope = ctx.configForms.get<SearchSettingsView>(SEARCH_ENTRY_ID)
    const imageScope = ctx.configForms.get<ImageSettingsView>(IMAGE_ENTRY_ID)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'codex-auth',
      order: 20,
      label: () => t('nav'),
      inject: (): CodexCapabilitySettingsProps => ({ rpc, t, subscribe, llmScope, searchScope, imageScope }),
    }, CodexCapabilitySettings))
  }

  const ToolView = imageToolView(imageUrls)
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image',
    locale: NS,
  }, ToolView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'list_images',
  }, ListImagesToolView))
}

type LocalizedToolViewProps = ToolCallViewProps & PropsLocale<typeof NS>

/** list_images is model-facing catalog state and deliberately has no user-facing card. */
function ListImagesToolView(): null {
  return null
}

function imageToolView(imageUrls: SessionImageUrls): (props: LocalizedToolViewProps) => ReactElement {
  return function RegisteredCodexImageToolView(props: LocalizedToolViewProps): ReactElement {
    const loadImage = useCallback(
      (attachment: ImageAttachmentRef) => imageUrls.resolve(props.sessionId, attachment),
      [props.sessionId, imageUrls],
    )
    return createElement(CodexImageToolView, { block: props.block, loadImage, t: props.t })
  }
}
