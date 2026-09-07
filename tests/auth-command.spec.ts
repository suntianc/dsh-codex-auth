import { describe, expect, it, vi } from 'vitest'
import { createCodexAuthCommand } from '../src/auth-command.ts'
import type { LoopbackRpcMode } from '../src/loopback-rpc.ts'

function makeCommand(service: Record<string, ReturnType<typeof vi.fn>>, mode: LoopbackRpcMode = 'enabled') {
  return createCodexAuthCommand(service as never, () => mode)
}

describe('Codex auth command', () => {
  it('reports value-free login status by default', async () => {
    const service = {
      login: vi.fn(),
      status: vi.fn(async () => ({
        available: true,
        configured: true,
        codexVersion: 'codex-cli 1.2.3',
        planType: 'plus',
        credentialRef: 'CODEX_CHATGPT_TOKEN',
        authFileExists: true,
      })),
    }
    const command = makeCommand(service)

    await expect(command.handler({ rawInput: '' } as never)).resolves.toEqual({
      kind: 'success',
      text: 'Codex auth: configured; CLI available; plan plus; codex-cli 1.2.3',
    })
    expect(service.login).not.toHaveBeenCalled()
  })

  it('starts the official browser login flow', async () => {
    const service = {
      login: vi.fn(async () => ({ started: true })),
      status: vi.fn(),
    }
    const command = makeCommand(service)

    await expect(command.handler({ rawInput: ' login ' } as never)).resolves.toEqual({
      kind: 'success',
      text: 'Codex browser login started; run /codex-auth status after authorization completes.',
    })
    expect(service.login).toHaveBeenCalledWith('browser')
  })

  it('rejects unknown operations without starting login', async () => {
    const service = {
      login: vi.fn(),
      status: vi.fn(),
    }
    const command = makeCommand(service)

    await expect(command.handler({ rawInput: 'device' } as never)).resolves.toEqual({
      kind: 'error',
      text: 'unknown operation "device" (available: status, login)',
    })
    expect(service.login).not.toHaveBeenCalled()
    expect(service.status).not.toHaveBeenCalled()
  })

  it.each(['', 'status', 'login'])(
    'denies %s off-loopback without reaching the auth service',
    async (rawInput) => {
      const service = {
        login: vi.fn(),
        status: vi.fn(),
      }
      const command = makeCommand(service, 'blocked')

      await expect(command.handler({ rawInput } as never)).resolves.toEqual({
        kind: 'error',
        text: 'Codex account controls require a loopback-bound DSH Host',
      })
      expect(service.login).not.toHaveBeenCalled()
      expect(service.status).not.toHaveBeenCalled()
    },
  )
})
