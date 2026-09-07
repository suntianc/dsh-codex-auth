/** Human command for inspecting and starting the shared Codex login. */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { CodexAuthService } from './codex-auth-service.ts'
import type { CodexAuthStatusView } from './rpc-contract.ts'

type AuthCommandService = Pick<CodexAuthService, 'login' | 'status'>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatStatus(status: CodexAuthStatusView): string {
  const parts = [
    status.configured ? 'configured' : 'not configured',
    status.available ? 'CLI available' : 'CLI unavailable',
  ]
  if (status.planType !== undefined) parts.push(`plan ${status.planType}`)
  if (status.codexVersion !== undefined) parts.push(status.codexVersion)
  return `Codex auth: ${parts.join('; ')}`
}

/** Build the slash command shared by every interactive DSH surface. */
export function createCodexAuthCommand(service: AuthCommandService): CommandDefinition {
  return {
    name: 'codex-auth',
    description: 'Inspect or start the Codex ChatGPT login',
    input: { hint: '[status|login]' },
    handler: async ({ rawInput }) => {
      const operation = rawInput.trim() || 'status'
      if (operation === 'status') {
        try {
          return { kind: 'success', text: formatStatus(await service.status()) }
        } catch (error) {
          return { kind: 'error', text: `reading Codex auth status failed: ${errorMessage(error)}` }
        }
      }
      if (operation === 'login') {
        try {
          const result = await service.login('browser')
          return result.started
            ? {
                kind: 'success',
                text: 'Codex browser login started; run /codex-auth status after authorization completes.',
              }
            : { kind: 'error', text: 'Codex browser login did not start.' }
        } catch (error) {
          return { kind: 'error', text: `starting Codex browser login failed: ${errorMessage(error)}` }
        }
      }
      return { kind: 'error', text: `unknown operation "${operation}" (available: status, login)` }
    },
  }
}
