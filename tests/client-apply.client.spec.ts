/** GPT Auth settings registration, dedicated caller injection, and cleanup. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { CodexAuthCardInjected } from '../src/client/CodexAuthCard.tsx'
import type { CodexAuthKey } from '../src/client/locales.ts'

type Dictionary = Record<CodexAuthKey, string>

interface SectionRecord {
  options: {
    id: string
    order: number
    label: () => string
  }
  inject: () => CodexAuthCardInjected
}

function bench() {
  const call = vi.fn(() => Promise.resolve({ ok: true as const, value: { status: {
    available: true,
    configured: true,
    credentialRef: 'CODEX_CHATGPT_TOKEN',
    authFileExists: true,
  } } }))
  const disposers: Array<() => void> = []
  const dictionaries = new Map<string, { zh: Dictionary; en: Dictionary }>()
  const sections: SectionRecord[] = []
  const listeners = new Set<() => void>()

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
    slots: {
      inject(_name: string, register: () => () => void) {
        disposers.push(register())
      },
      register(options: SectionRecord['options'] & { inject: SectionRecord['inject'] }) {
        const record = { options, inject: options.inject }
        sections.push(record)
        return () => {
          const index = sections.indexOf(record)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    get(service: string) {
      if (service !== 'connection') throw new Error(`unexpected service: ${service}`)
      return { rpc: { call } }
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
    call,
    dictionaries,
    listeners,
    sections,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

describe('dsh-codex-auth client apply', () => {
  it('declares only the stock services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection'])
  })

  it('registers an independent section and cleans up every contribution', async () => {
    const b = bench()
    const entry = b.sections[0]
    expect(entry?.options).toMatchObject({ id: 'codex-auth', order: 20 })
    expect(entry?.options.label()).toBe('GPT Auth')

    const injected = entry?.inject()
    await injected?.rpc.status()
    expect(b.call).toHaveBeenCalledWith('/codex-auth', 'status', {}, undefined)
    expect(injected?.t('title')).toBe('GPT Auth via codex')

    b.dispose()
    expect(b.sections).toHaveLength(0)
    expect(b.listeners.size).toBe(0)
    expect(b.dictionaries.size).toBe(0)
  })
})
