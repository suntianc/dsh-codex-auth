/** Best-effort, fork/resume-preserved plugin preference outside model history. */
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type { CodexFastModeView } from './rpc-contract.ts'

const RECORD = 'plugin:dsh-codex-auth/fast-mode'
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-codex-auth/fast-mode': { enabled: boolean }
  }
}

export function sessionFastMode(session: Session | undefined): boolean | undefined {
  const events = session?.snapshotEvents() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const record = pluginRecordOf(events[i]!)
    if (record?.type !== RECORD) continue
    const data = record.data
    if (typeof data === 'object' && data !== null && 'enabled' in data && typeof data.enabled === 'boolean') return data.enabled
  }
  return undefined
}

export function sessionFastModeView(session: Session, profileDefault: boolean): CodexFastModeView {
  const override = sessionFastMode(session)
  return { enabled: override ?? profileDefault, source: override === undefined ? 'profile' : 'session' }
}

export function saveSessionFastMode(session: Session, enabled: boolean): void {
  if (sessionFastMode(session) !== enabled) appendPluginRecord(session, RECORD, { enabled })
}
