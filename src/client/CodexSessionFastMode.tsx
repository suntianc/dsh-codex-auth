import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CodexAuthRpcClient, CodexFastModeView } from '../rpc-contract.ts'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexUsageFooter.module.css'

export function CodexSessionFastMode({ rpc, sessionId, t, subscribe }: {
  rpc: CodexAuthRpcClient
  sessionId: string
  t: (key: CodexAuthKey) => string
  subscribe: (listener: () => void) => () => void
}): ReactNode {
  const [state, setState] = useState<CodexFastModeView>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [controller, setController] = useState<AbortController>()
  useEffect(() => subscribe(() => { setRevision(value => value + 1) }), [subscribe])
  useEffect(() => {
    const abort = new AbortController()
    setController(abort)
    setState(undefined)
    setBusy(true)
    setError(false)
    const read = async () => {
      try {
        const result = await rpc.fastMode(sessionId, undefined, abort.signal)
        if (!abort.signal.aborted) { setState(result.ok ? result.value.fastMode : undefined); setError(!result.ok) }
      } catch { if (!abort.signal.aborted) setError(true) }
      finally { if (!abort.signal.aborted) setBusy(false) }
    }
    void read()
    return () => { abort.abort() }
  }, [rpc, sessionId, revision])
  const save = async () => {
    if (state === undefined || busy || controller === undefined) return
    setBusy(true)
    setError(false)
    try {
      const result = await rpc.fastMode(sessionId, !state.enabled, controller.signal)
      if (!controller.signal.aborted) {
        if (result.ok) setState(result.value.fastMode)
        else {
          setError(true)
          // A failed durability barrier can leave a live append. Re-read the
          // effective state without claiming it was durably saved.
          const current = await rpc.fastMode(sessionId, undefined, controller.signal)
          if (!controller.signal.aborted && current.ok) setState(current.value.fastMode)
        }
      }
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return (
    <button type="button" role="switch" className={classes.pill}
      aria-label={t('sessionFastLabel')} aria-checked={state?.enabled === true}
      disabled={busy}
      title={`${t('sessionFastHint')}${state?.source === 'profile' ? ` ${t('sessionFastInherited')}` : ''}${error ? ` ${t('sessionFastError')}` : ''}`}
      onClick={() => { if (state === undefined) setRevision(value => value + 1); else void save() }}>
      Fast · {error ? t('sessionFastError') : state === undefined ? '…' : state.enabled ? t('sessionFastOn') : t('sessionFastOff')}
    </button>
  )
}
