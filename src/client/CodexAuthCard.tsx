/**
 * Status card for ChatGPT authentication through the local Codex CLI.
 * Credentials never cross the dedicated plugin-owned Connection RPC channel.
 *
 * @module dsh-codex-auth/client/card
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconRefreshOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexAuthRpcClient, CodexAuthStatusView } from '../rpc-contract.ts'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexAuthCard.module.css'

/** Props injected by the client plugin's slot registration. */
export interface CodexAuthCardInjected {
  /** Dedicated plugin-owned RPC face. */
  rpc: CodexAuthRpcClient
  /** Localized dictionary reader. */
  t: (key: CodexAuthKey) => string
  /** Subscribe to connection resets that invalidate the current view. */
  subscribe: (listener: () => void) => () => void
}

type LoadState = 'loading' | 'ready' | 'error'

/** The GPT Auth-via-codex login card. */
export function CodexAuthCard({ rpc, t, subscribe }: CodexAuthCardInjected): ReactNode {
  const [status, setStatus] = useState<CodexAuthStatusView | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => subscribe(() => { setTick(value => value + 1) }), [subscribe])

  const load = useCallback(async () => {
    setLoadState('loading')
    setError(null)
    try {
      const result = await rpc.status()
      if (!result.ok) {
        setStatus(null)
        setLoadState('error')
        setError(result.error.message || t('statusFailed'))
        return
      }
      setStatus(result.value.status)
      setLoadState('ready')
    } catch (cause) {
      setStatus(null)
      setLoadState('error')
      setError(messageOf(cause, t('statusFailed')))
    }
  }, [rpc, t])

  useEffect(() => { void load() }, [load, tick])

  const startLogin = useCallback(async (mode: 'browser' | 'device') => {
    setLoginBusy(true)
    setError(null)
    try {
      const result = await rpc.login(mode)
      if (!result.ok) setError(result.error.message || t('loginFailed'))
    } catch (cause) {
      setError(messageOf(cause, t('loginFailed')))
    } finally {
      setLoginBusy(false)
    }
  }, [rpc, t])

  const state = stateOf(loadState, status)
  const stateLabel = stateText(loadState, status, t)

  return (
    <section className={classes.card}>
      <h2 className={classes.title}>{t('title')}</h2>
      <p className={classes.intro}>{t('intro')}</p>

      <div className={classes.statusSurface}>
        <div className={classes.statusHead}>
          <span className={classes.statusIdentity}>
            <StateDot state={state} />
            <span className={classes.statusLabel}>{stateLabel}</span>
          </span>
          {loadState === 'ready' && status?.configured === true
            ? <span className={classes.statusSummary}>{t('statusAvailable')}</span>
            : null}
        </div>
        {status === null ? null : (
          <dl className={classes.facts}>
            {status.authMode === undefined ? null : <Fact label={t('authMode')} value={status.authMode} />}
            {status.codexVersion === undefined ? null : <Fact label={t('codexVersion')} value={status.codexVersion} />}
            {status.tokenExpiresAt === undefined ? null : <Fact label={t('tokenExpiresAt')} value={localDate(status.tokenExpiresAt)} />}
            {status.lastRefreshAt === undefined ? null : <Fact label={t('lastRefreshAt')} value={localDate(status.lastRefreshAt)} />}
            <Fact label={t('credentialRef')} value={status.credentialRef} />
          </dl>
        )}
      </div>

      <div className={classes.actions}>
        <Button
          variant="primary"
          disabled={loginBusy || status?.available !== true}
          onClick={() => { void startLogin('browser') }}
        >
          {loginBusy ? t('startingLogin') : status?.configured === true ? t('relogin') : t('login')}
        </Button>
        <Button
          variant="outline"
          disabled={loginBusy || status?.available !== true}
          onClick={() => { void startLogin('device') }}
        >
          {t('deviceLogin')}
        </Button>
        <Button
          variant="ghost"
          className={classes.refresh}
          icon={<IconRefreshOutline16 size={16} />}
          disabled={loadState === 'loading'}
          onClick={() => { void load() }}
        >
          {loadState === 'loading' ? t('refreshing') : t('refresh')}
        </Button>
      </div>

      {error === null ? null : <p className={classes.error} role="alert">{error}</p>}
      {status?.available === true && !status.configured ? <p className={classes.hint}>{t('loginHint')}</p> : null}
      <p className={classes.privacy}>{t('privacyNotice')}</p>
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={classes.factRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function stateOf(loadState: LoadState, status: CodexAuthStatusView | null): StateDotState {
  if (loadState === 'loading') return 'ongoing'
  if (loadState === 'error' || status === null) return 'error'
  if (status.configured) return 'done'
  return status.available ? 'warning' : 'error'
}

function stateText(
  loadState: LoadState,
  status: CodexAuthStatusView | null,
  t: CodexAuthCardInjected['t'],
): string {
  if (loadState === 'loading') return t('refreshing')
  if (loadState === 'error' || status === null) return t('statusFailed')
  if (status.configured) return t('loggedIn')
  if (!status.available) return t('notAvailable')
  return status.authFileExists ? t('loggedOut') : t('authFileMissing')
}

function localDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const message = String(error)
  return message.length > 0 ? message : fallback
}
