/**
 * Codex-auth login plugin, browser half. Registers a Settings status card
 * backed only by this package's dedicated Connection RPC channel.
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createCodexAuthRpcClient } from '../rpc-contract.ts'
import { CodexAuthCard } from './CodexAuthCard.tsx'
import type { CodexAuthCardInjected } from './CodexAuthCard.tsx'
import { en, zh, type CodexAuthKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The GPT Auth-via-codex login card copy. */
    'settings.codexAuth': CodexAuthKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.codexAuth'

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection']

/** Register the independently navigable GPT Auth card. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-codex-auth: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = createCodexAuthRpcClient(connection.rpc)
  const t = ctx.locale.bind(NS) as CodexAuthCardInjected['t']

  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const notify = (): void => { for (const listener of listeners) listener() }

  ctx.effect(
    () => ctx.on('connection/reset', notify),
    'llm-codex-auth: connection invalidation',
  )

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codex-auth',
    order: 20,
    label: () => t('nav'),
    inject: (): CodexAuthCardInjected => ({ rpc, t, subscribe }),
  }, CodexAuthCard))
}
