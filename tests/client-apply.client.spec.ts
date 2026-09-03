/** Browser contribution registration, dedicated injections, and cleanup. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CodexCapabilitySettingsProps } from '../src/client/CodexCapabilitySettings.tsx'
import type { CodexAuthKey } from '../src/client/locales.ts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-attachment', () => ({ ImageGallery: () => null }))

import { apply, inject } from '../src/client/index.ts'

type Dictionary = Record<CodexAuthKey, string>

interface SlotRecord {
  options: Record<string, unknown>
  component: unknown
}

function bench(isLoopback = true) {
  const call = vi.fn(() => Promise.resolve({ ok: true as const, value: { status: {
    available: true,
    configured: true,
    credentialRef: 'CODEX_CHATGPT_TOKEN',
    authFileExists: true,
  } } }))
  const disposers: Array<() => void> = []
  const dictionaries = new Map<string, { zh: Dictionary; en: Dictionary }>()
  const slots: SlotRecord[] = []
  const listeners = new Set<() => void>()
  const bindScope = vi.fn(({ namespace }: { namespace: string }) => ({ namespace }))

  const ctx = {
    locale: {
      register(namespace: string, dictionariesForNamespace: { zh: Dictionary; en: Dictionary }) {
        dictionaries.set(namespace, dictionariesForNamespace)
        return () => { dictionaries.delete(namespace) }
      },
      bind(namespace: string) {
        return (key: CodexAuthKey) => dictionaries.get(namespace)?.en[key] ?? key
      },
    },
    settingsScope: { bind: bindScope },
    sessions: { binding: vi.fn() },
    slots: {
      inject(_name: string, register: () => () => void) { disposers.push(register()) },
      register(options: Record<string, unknown>, component: unknown) {
        const record = { options, component }
        slots.push(record)
        return () => {
          const index = slots.indexOf(record)
          if (index >= 0) slots.splice(index, 1)
        }
      },
    },
    get(service: string) {
      if (service === 'connection') return { isLoopback, rpc: { call } }
      throw new Error(`unexpected service: ${service}`)
    },
    effect(effect: () => (() => void)) {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
    on(event: string, listener: () => void) {
      if (event !== 'connection/reset') throw new Error(`unexpected event: ${event}`)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  apply(ctx as unknown as ClientContext)
  return {
    bindScope,
    call,
    dictionaries,
    listeners,
    slots,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

describe('dsh-codex-auth client apply', () => {
  it('declares every stock service it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope', 'sessions'])
  })

  it('registers only settings and image views, never a native conversation renderer', async () => {
    const b = bench()
    expect(b.bindScope).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'codex-llm' }))
    expect(b.bindScope).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'codex-search' }))
    expect(b.bindScope).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'codex-image' }))
    expect(b.slots).toHaveLength(3)
    expect(b.slots.map(record => record.options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'settings.section', id: 'codex-auth', order: 20 }),
      expect.objectContaining({ name: 'tool.call.toolview', key: 'generate_image' }),
      expect.objectContaining({ name: 'tool.call.toolview', key: 'list_images' }),
    ]))
    expect(b.slots.some(record => String(record.options.name).includes('conversation'))).toBe(false)

    const settings = b.slots.find(record => record.options.name === 'settings.section')
    const injected = (settings?.options.inject as (() => CodexCapabilitySettingsProps) | undefined)?.()
    await injected?.rpc.status()
    expect(b.call).toHaveBeenCalledWith('/codex-auth', 'status', {}, undefined)
    expect(injected?.t('nav')).toBe('GPT Auth')

    b.dispose()
    expect(b.slots).toHaveLength(0)
    expect(b.listeners.size).toBe(0)
    expect(b.dictionaries.size).toBe(0)
  })

  it('keeps image result views but omits privileged settings off loopback', () => {
    const b = bench(false)

    expect(b.bindScope).not.toHaveBeenCalled()
    expect(b.slots).toHaveLength(2)
    expect(b.slots.map(record => record.options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tool.call.toolview', key: 'generate_image' }),
      expect.objectContaining({ name: 'tool.call.toolview', key: 'list_images' }),
    ]))
    expect(b.slots.some(record => record.options.name === 'settings.section')).toBe(false)
    expect(b.call).not.toHaveBeenCalled()

    b.dispose()
    expect(b.slots).toHaveLength(0)
  })
})
