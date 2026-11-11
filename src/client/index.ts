/** Browser half of the Codex Capability Bundle. */
import { createElement, useCallback, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { CodexTurnImages, generatedImageDefinition } from './CodexTurnImages.tsx'
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
import { CodexUsageFooter } from './CodexUsageFooter.tsx'

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
const LLM_NAMESPACE = 'llm-codex-auth'
const SEARCH_NAMESPACE = 'codex-search'
const IMAGE_NAMESPACE = 'codex-image'

/** Required browser services, including session-authorized attachment reads. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'configForms', 'sessions', 'uiConversation', 'conversation']

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
    const llmScope = ctx.configForms.get<LlmSettingsView>(LLM_NAMESPACE)
    const searchScope = ctx.configForms.get<SearchSettingsView>(SEARCH_NAMESPACE)
    const imageScope = ctx.configForms.get<ImageSettingsView>(IMAGE_NAMESPACE)
    const subscribePolicy = (listener: () => void) => {
      const reset = subscribe(listener)
      const settings = llmScope.subscribe(listener)
      return () => { reset(); settings() }
    }
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'codex-usage',
      order: 2,
      inject: sessionId => ({ rpc, t, subscribe: subscribePolicy, sessionId }),
    }, CodexUsageFooter))
    ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
      name: 'conversation.hero.options',
      id: 'codex-usage',
      order: 2,
      inject: sessionId => ({ rpc, t, subscribe: subscribePolicy, sessionId }),
    }, CodexUsageFooter))
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'codex-auth',
      order: 20,
      label: () => t('nav'),
      inject: (): CodexCapabilitySettingsProps => ({ rpc, t, subscribe, llmScope, searchScope, imageScope }),
    }, CodexCapabilitySettings))
  }

  ctx.uiConversation.events.register(generatedImageDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'codex-generated-images', locale: NS,
    inject: (sessionId: SessionId) => ({
      loadImage: (image: ImageAttachmentRef) => imageUrls.resolve(sessionId, image),
      editImage: (_image: ImageAttachmentRef, prompt: string) => {
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return false
        const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' })
        if (result !== 'applied') return false
        ctx.conversation.input.for(binding.ctx).focus()
        return true
      },
    }),
  }, ImageTurnTail))

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
    if ('kind' in props.block && !props.block.isError) return createElement(ListImagesToolView)
    return createElement(CodexImageToolView, { block: props.block, loadImage, t: props.t })
  }
}

const NO_IMAGES: readonly ImageAttachmentRef[] = []

/** Completed-turn gallery and explicit image-edit draft action. */
function ImageTurnTail(props: PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & {
  loadImage: (image: ImageAttachmentRef) => Promise<string>
  editImage: (image: ImageAttachmentRef, prompt: string) => boolean
}): ReactElement {
  const source = props.turn.data.source('codexImages')
  const images = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot) ?? NO_IMAGES
  return createElement(CodexTurnImages, {
    images, loadImage: props.loadImage, t: props.t,
    editImage: image => props.editImage(image, props.t('editImagePrompt')
      + `image:${String(image.attachmentId)}`
      + '\n' + props.t('editImageChanges')),
  })
}
