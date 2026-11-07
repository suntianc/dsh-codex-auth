/** Account allowance in the public composer dock, separate from context occupancy. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
  const [updatedAt, setUpdatedAt] = useState<number>()
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribe(() => {
    setUsage(undefined)
    setUpdatedAt(undefined)
    setFailed(false)
    setRevision(value => value + 1)
  }), [subscribe])
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await rpc.usage(controller.signal)
        if (!controller.signal.aborted) {
          const next = result.ok ? result.value.usage : undefined
          const known = next?.weeklyRemainingPercent !== undefined || next?.fiveHourRemainingPercent !== undefined
          if (known) { setUsage(next); setUpdatedAt(Date.now()) }
          setFailed(!known)
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 300_000)
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
  const text = parts.length === 0 ? `Codex · ${t('quotaUnknown')}` : `Codex · ${parts.join(' · ')}${failed ? ` · ${t('quotaStale')}` : ''}`
  return (
    <>
      {sessionId === undefined ? null : <CodexSessionFastMode key={sessionId} rpc={rpc} t={t} subscribe={subscribe} sessionId={sessionId} />}
      <button type="button" className={classes.pill} title={`${details.join('\n')}\n${t('quotaRefresh')}`}
        aria-label={`${text}. ${details.join('. ')}. ${t('quotaRefresh')}`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}>
        {text}
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={t('quotaDialogTitle')}
        closeLabel={t('quotaClose')} description={t('quotaDialogHint')}>
        <dl className={classes.quotaFacts}>
          <div><dt>{t('plan')}</dt><dd>{usage?.planType === undefined ? t('unknownPlan') : planLabel(usage.planType)}</dd></div>
          <div><dt>{t('quotaLastChecked')}</dt><dd>{updatedAt === undefined ? t('quotaNotReported') : new Date(updatedAt).toLocaleString()}</dd></div>
        </dl>
        {failed ? <p role="status" className={classes.quotaNotice}>{usage === undefined ? t('quotaLoadFailed') : t('quotaLastKnown')}</p> : null}
        <div className={classes.quotaWindows}>
          {([
            [t('quotaWeeklyWindow'), usage?.weeklyRemainingPercent, usage?.weeklyResetAt],
            [t('quotaFiveHourWindow'), usage?.fiveHourRemainingPercent, usage?.fiveHourResetAt],
          ] as const).map(([label, percent, reset]) => (
            <section key={label} className={classes.quotaWindow} aria-label={label}>
              <h3>{label}</h3>
              {percent === undefined ? <p>{usage === undefined ? t('quotaUnknown') : t('quotaNotReported')}</p> : <>
                <strong>{percent}% <span>{t('quotaRemaining')}</span></strong>
                <progress max={100} value={percent} aria-label={`${label}: ${t('quotaRemaining')}`} />
              </>}
              <p>{t('quotaResets')}: {reset === undefined || !Number.isFinite(Date.parse(reset)) ? t('quotaNotReported') : new Date(reset).toLocaleString()}</p>
            </section>
          ))}
        </div>
      </Modal>
    </>
  )
}

function planLabel(plan: string): string {
  const known: Record<string, string> = { free: 'Free', plus: 'Plus', pro: 'Pro', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' }
  return known[plan.toLowerCase()] ?? plan
}
