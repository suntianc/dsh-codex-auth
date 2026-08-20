/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { CodexImageSettings } from '../src/image.ts'
import type { CodexSearchSettings } from '../src/search.ts'
import type { CodexAuthRpcClient, CodexAuthStatusView, CodexUsageView } from '../src/rpc-contract.ts'
import {
  CodexCapabilitySettings, CodexImageToolView, apply, inject,
} from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-attachment', () => ({
  ImageGallery: ({ images }: { images: Array<{ attachment: ImageAttachmentRef }> }) => (
    <div>{images.map(({ attachment }) => <img key={String(attachment.attachmentId)} alt={attachment.name ?? 'Generated image'} />)}</div>
  ),
}))

const SEARCH: CodexSearchSettings = {
  enabled: true,
  mode: 'live',
  contextSize: 'medium',
  fallbackModel: 'gpt-5.4',
  maxOutputTokens: 2048,
}
const IMAGE: CodexImageSettings = {
  enabled: true,
  model: 'gpt-image-2',
  n: 1,
  size: 'auto',
  quality: 'auto',
  background: 'auto',
}

function fakeScope<T>(
  initial: T,
  status: SettingsScopeSnapshot<T>['status'] = 'ready',
): { scope: SettingsScope<T>; set: ReturnType<typeof vi.fn> } {
  let snapshot: SettingsScopeSnapshot<T> = {
    status,
    value: initial,
    base: initial,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }
    for (const listener of listeners) listener()
  })
  const scope = {
    getSnapshot() {
      if (this !== scope) throw new Error('getSnapshot lost its SettingsScope receiver')
      return snapshot
    },
    subscribe(listener: () => void) {
      if (this !== scope) throw new Error('subscribe lost its SettingsScope receiver')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set,
    unset: vi.fn(async () => {}),
  } satisfies SettingsScope<T>
  return { set, scope }
}

function authStatus(overrides: Partial<CodexAuthStatusView>): CodexAuthStatusView {
  return {
    available: true,
    configured: true,
    credentialRef: '~/.codex/auth.json',
    authFileExists: true,
    ...overrides,
  }
}

function rpc(status: CodexAuthStatusView, usage: CodexUsageView = {}): CodexAuthRpcClient {
  return {
    status: vi.fn(async () => ({ ok: true as const, value: { status } })),
    usage: vi.fn(async () => ({ ok: true as const, value: { usage } })),
    login: vi.fn(async () => ({ ok: true as const, value: { started: true } })),
  }
}

const t = (key: keyof typeof en): string => en[key]
const subscribe = (): (() => void) => () => {}

afterEach(() => cleanup())

describe('Codex Capability Bundle settings', () => {
  it('renders Login, Search, and Image Creation as one live three-card section', async () => {
    const search = fakeScope(SEARCH)
    const image = fakeScope(IMAGE)
    render(<CodexCapabilitySettings
      rpc={rpc(
        authStatus({ credentialRef: '/Users/alice/.codex/auth.json', accountId: 'acct-1', planType: 'plus' }),
        { weeklyRemainingPercent: 49, weeklyResetAt: '2026-08-20T12:00:00.000Z' },
      )}
      t={t}
      subscribe={subscribe}
      searchScope={search.scope}
      imageScope={image.scope}
    />)

    expect(await screen.findByText('Active')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Login' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Web Search' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Image Creation' })).toBeTruthy()
    // The login block only surfaces plan, remaining quota, and weekly reset.
    expect(screen.getByText('Plus plan')).toBeTruthy()
    expect(screen.getByText('49%')).toBeTruthy()
    expect(screen.getByText('Remaining quota')).toBeTruthy()
    expect(screen.getByText('Weekly limit resets')).toBeTruthy()
    expect(screen.queryByText('acct-1')).toBeNull()
    expect(screen.queryByText('/Users/alice/.codex/auth.json')).toBeNull()
    expect(screen.getByText(/no token value is ever sent to the Web client/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search mode'), { target: { value: 'cached' } })
    await waitFor(() => expect(search.set).toHaveBeenCalledWith('mode', 'cached'))
    fireEvent.change(screen.getByLabelText('Default image count'), { target: { value: '3' } })
    await waitFor(() => expect(image.set).toHaveBeenCalledWith('n', 3))
  })

  it('announces loading settings while keeping skeleton rows decorative', async () => {
    const { container } = render(<CodexCapabilitySettings
      rpc={rpc(authStatus({ planType: 'plus' }))}
      t={t}
      subscribe={subscribe}
      searchScope={fakeScope(SEARCH, 'loading').scope}
      imageScope={fakeScope(IMAGE, 'loading').scope}
    />)

    expect(await screen.findByText('Active')).toBeTruthy()
    expect(screen.getAllByText('Loading settings…')).toHaveLength(2)
    const busyRegions = screen.getAllByRole('status')
      .filter(region => region.getAttribute('aria-busy') === 'true')
    expect(busyRegions).toHaveLength(2)
    expect(container.querySelectorAll('[aria-busy="true"] > div:not([aria-hidden="true"])')).toHaveLength(0)
  })

  it('identifies a known Free plan while leaving unknown plans backend-authoritative', async () => {
    const { rerender } = render(<CodexCapabilitySettings
      rpc={rpc(authStatus({ credentialRef: '/tmp/auth.json', accountId: 'acct-free', planType: 'free' }))}
      t={t}
      subscribe={subscribe}
      searchScope={fakeScope(SEARCH).scope}
      imageScope={fakeScope(IMAGE).scope}
    />)
    expect(await screen.findByText('Unavailable on Free plan')).toBeTruthy()
    expect((screen.getByLabelText('Enable Image Creation') as HTMLInputElement).disabled).toBe(true)

    rerender(<CodexCapabilitySettings
      rpc={rpc(authStatus({ credentialRef: '/tmp/auth.json' }))}
      t={t}
      subscribe={subscribe}
      searchScope={fakeScope(SEARCH).scope}
      imageScope={fakeScope(IMAGE).scope}
    />)
    // A configured non-Free plan carries no badge on either capability card.
    expect(await screen.findByText('Unknown plan')).toBeTruthy()
    expect(screen.queryByText('Entitlement checked on use')).toBeNull()
    expect(screen.queryByText('Deployment-wide provider')).toBeNull()

    rerender(<CodexCapabilitySettings
      rpc={rpc(authStatus({ configured: false, authFileExists: false }))}
      t={t}
      subscribe={subscribe}
      searchScope={fakeScope(SEARCH).scope}
      imageScope={fakeScope(IMAGE).scope}
    />)
    expect((await screen.findAllByText('Available after login')).length).toBe(2)
    expect((screen.getByLabelText('Enable Web Search') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Enable Image Creation') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('Codex Image Creation tool view', () => {
  it('renders only generated images after a successful call', async () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: 'att-1' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 68,
      width: 1,
      height: 1,
      name: 'generated.png',
    }
    const block: ToolCallBlock = {
      kind: 'tool-result',
      seq: 3,
      time: 30,
      callId: 'call-1',
      call: { name: 'generate_image', argsRaw: '{"prompt":"fox"}' },
      callTime: 10,
      content: [{ type: 'image', attachment }],
      isError: false,
      meta: {
        operation: 'generate',
        images: [{ handle: 'image:att-1', attachment, origin: 'generated' }],
        references: [],
        warnings: [{ index: 1, code: 'IMAGE_MEDIA_INVALID', message: 'One item was invalid.' }],
      },
      callView: null,
      resultView: null,
      subCalls: [],
    }
    const loadImage = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')

    const { container } = render(<CodexImageToolView block={block} loadImage={loadImage} />)

    expect(await screen.findByRole('img', { name: 'generated.png' })).toBeTruthy()
    expect(container.textContent).toBe('')
    expect(screen.queryByText('image:att-1')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save to workspace' })).toBeNull()
  })

  it('shows a stable in-progress state before a tool result lands', () => {
    const block: ToolCallBlock = {
      callId: 'call-1',
      name: 'generate_image',
      argsRaw: '{"prompt":"fox"}',
      turn: 1,
      step: 1,
      time: 10,
      callView: null,
      subCalls: [],
    }
    const { rerender } = render(<CodexImageToolView block={block} loadImage={vi.fn()} />)
    expect(screen.getByText('Creating images…')).toBeTruthy()
    rerender(<CodexImageToolView block={block} loadImage={vi.fn()} t={key => zh[key]} />)
    expect(screen.getByText('正在创作图片…')).toBeTruthy()
  })
})

describe('client plugin registration', () => {
  it('registers one settings row and keyed views for both image tools', () => {
    const registered: Array<Record<string, unknown>> = []
    const scopes = new Map([
      ['codex-search', fakeScope(SEARCH).scope],
      ['codex-image', fakeScope(IMAGE).scope],
    ])
    const sessions = { binding: vi.fn() }
    const connection = { rpc: { call: vi.fn() } }
    const ctx = {
      effect: (setup: () => unknown) => setup(),
      on: vi.fn(() => () => {}),
      get: (name: string) => name === 'connection' ? connection : undefined,
      sessions,
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, setup: () => unknown) => setup(),
        register: (registration: Record<string, unknown>, component: unknown) => {
          registered.push({ ...registration, component })
          return () => {}
        },
      },
      settingsScope: {
        bind: ({ namespace }: { namespace: string }) => scopes.get(namespace),
      },
    }

    apply(ctx as never)

    expect(inject).toEqual(expect.arrayContaining(['remote', 'settingsScope', 'sessions']))
    expect(registered).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'settings.section', id: 'codex-auth' }),
      expect.objectContaining({ name: 'tool.call.toolview', key: 'generate_image' }),
      expect.objectContaining({ name: 'tool.call.toolview', key: 'list_images' }),
    ]))

    const ListImagesView = registered.find(item => item.key === 'list_images')?.component as ComponentType<{
      block: ToolCallBlock
      sessionId: string
      t: typeof t
    }>
    const listBlock: ToolCallBlock = {
      kind: 'tool-result',
      seq: 4,
      time: 40,
      callId: 'call-list',
      call: { name: 'list_images', argsRaw: '{}' },
      callTime: 30,
      content: [],
      isError: false,
      meta: { operation: 'list', items: [], nextCursor: null },
      callView: null,
      resultView: null,
      subCalls: [],
    }
    const listResult = render(<ListImagesView block={listBlock} sessionId="session-a" t={t} />)
    expect(listResult.container.firstElementChild).toBeNull()
  })
})
