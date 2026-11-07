/** Account allowance in the public composer dock, separate from context occupancy. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CodexAuthRpcClient, CodexUsageView } from '../rpc-contract.ts'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexUsageFooter.module.css'
import { CodexSessionFastMode } from './CodexSessionFastMode.tsx'

export interface CodexUsageFooterProps {
  sessionId?: string
  rpc: CodexAuthRpcClient
  t: (key: CodexAuthKey) => string
  subscribe: (listener: () => void) => () => void
}

export function CodexUsageFooter({ rpc, t, subscribe, sessionId }: CodexUsageFooterProps): ReactNode {
  const [usage, setUsage] = useState<CodexUsageView>()
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribe(() => { setUsage(undefined); setRevision(value => value + 1) }), [subscribe])
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await rpc.usage(controller.signal)
        if (!controller.signal.aborted) setUsage(result.ok ? result.value.usage : undefined)
      } catch {
        if (!controller.signal.aborted) setUsage(undefined)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 60_000)
    return () => { clearInterval(timer); controller.abort() }
  }, [rpc, revision])
  const parts: string[] = []
  const details = [t('quotaFooterRemaining')]
  for (const [label, percent, reset] of [
    [t('quotaFiveHour'), usage?.fiveHourRemainingPercent, usage?.fiveHourResetAt],
    [t('quotaWeekly'), usage?.weeklyRemainingPercent, usage?.weeklyResetAt],
  ] as const) {
    if (percent !== undefined) parts.push(`${label} ${percent}%`)
    if (reset !== undefined && Number.isFinite(Date.parse(reset))) {
      details.push(`${label} ${t('quotaResets')}: ${new Date(reset).toLocaleString()}`)
    }
  }
  const text = parts.length === 0 ? `Codex · ${t('quotaUnknown')}` : `Codex · ${parts.join(' · ')}`
  return (
    <>
    {sessionId === undefined ? null : <CodexSessionFastMode key={sessionId} rpc={rpc} t={t} subscribe={subscribe} sessionId={sessionId} />}
    <button type="button" className={classes.pill} title={`${details.join('\n')}\n${t('quotaRefresh')}`}
      aria-label={`${text}. ${details.join('. ')}. ${t('quotaRefresh')}`}
      onClick={() => { setUsage(undefined); setRevision(value => value + 1) }}>
      {text}
    </button>
    </>
  )
}
