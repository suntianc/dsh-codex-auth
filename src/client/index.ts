/** Browser half of the Codex Capability Bundle. */
import { createElement, useCallback } from 'react'
import type { ReactElement } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createCodexAuthRpcClient } from '../rpc-contract.ts'
import { CodexCapabilitySettings } from './CodexCapabilitySettings.tsx'
import type {
  CodexCapabilitySettingsProps, ImageSettingsView, SearchSettingsView,
} from './CodexCapabilitySettings.tsx'
import { CodexImageToolView } from './CodexImageToolView.tsx'
import { en, zh, type CodexAuthKey } from './locales.ts'
import { SessionImageUrls } from './SessionImageUrls.ts'

export { CodexCapabilitySettings } from './CodexCapabilitySettings.tsx'
export type { CodexCapabilitySettingsProps, ImageSettingsView, SearchSettingsView } from './CodexCapabilitySettings.tsx'
export { CodexImageToolView } from './CodexImageToolView.tsx'
export type { CodexImageToolViewProps } from './CodexImageToolView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the unified GPT Auth section. */
    'settings.codexAuth': CodexAuthKey
  }
}

const NS = 'settings.codexAuth'
const SEARCH_NAMESPACE = 'codex-search'
const IMAGE_NAMESPACE = 'codex-image'

/** Required browser services, including session-authorized attachment reads. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope', 'sessions']

/** Register the three-card settings section and keyed image result renderers. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'codex-capabilities: copy dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = createCodexAuthRpcClient(connection.rpc)
  const t = ctx.locale.bind(NS) as CodexCapabilitySettingsProps['t']
  const searchScope = ctx.settingsScope.bind<SearchSettingsView>({
    namespace: SEARCH_NAMESPACE,
    decode: decodeSearchSettings,
  })
  const imageScope = ctx.settingsScope.bind<ImageSettingsView>({
    namespace: IMAGE_NAMESPACE,
    decode: decodeImageSettings,
  })
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const imageUrls = new SessionImageUrls(ctx.sessions)
  ctx.effect(() => () => { imageUrls.clear() }, 'codex-capabilities: image URL cleanup')
  const reset = (): void => {
    imageUrls.clear()
    for (const listener of listeners) listener()
  }
  ctx.effect(() => ctx.on('connection/reset', reset), 'codex-capabilities: connection invalidation')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codex-auth',
    order: 20,
    label: () => t('nav'),
    inject: (): CodexCapabilitySettingsProps => ({ rpc, t, subscribe, searchScope, imageScope }),
  }, CodexCapabilitySettings))

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

function decodeSearchSettings(value: unknown): SearchSettingsView | undefined {
  if (!isRecord(value)
    || typeof value.enabled !== 'boolean'
    || !oneOf(value.mode, ['live', 'cached', 'indexed'])
    || !oneOf(value.contextSize, ['low', 'medium', 'high'])
    || typeof value.fallbackModel !== 'string'
    || !positiveInteger(value.maxOutputTokens)) return undefined
  return {
    enabled: value.enabled,
    mode: value.mode,
    contextSize: value.contextSize,
    fallbackModel: value.fallbackModel,
    maxOutputTokens: value.maxOutputTokens,
  }
}

function decodeImageSettings(value: unknown): ImageSettingsView | undefined {
  if (!isRecord(value)
    || typeof value.enabled !== 'boolean'
    || typeof value.model !== 'string'
    || !positiveInteger(value.n) || value.n > 10
    || !oneOf(value.size, ['auto', '1024x1024', '1536x1024', '1024x1536'])
    || !oneOf(value.quality, ['auto', 'low', 'medium', 'high'])
    || !oneOf(value.background, ['auto', 'opaque', 'transparent'])) return undefined
  return {
    enabled: value.enabled,
    model: value.model,
    n: value.n,
    size: value.size,
    quality: value.quality,
    background: value.background,
  }
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
