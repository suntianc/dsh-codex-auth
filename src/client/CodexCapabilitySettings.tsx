/** Unified three-card settings surface for the Codex Capability Bundle. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconRefreshOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexAuthRpcClient, CodexAuthStatusView, CodexUsageView } from '../rpc-contract.ts'
import type { CodexAuthKey } from './locales.ts'
import classes from './CodexCapabilitySettings.module.css'

export interface SearchSettingsView {
  enabled: boolean
  mode: 'live' | 'cached' | 'indexed'
  contextSize: 'low' | 'medium' | 'high'
  fallbackModel: string
  maxOutputTokens: number
}

export interface ImageSettingsView {
  enabled: boolean
  model: string
  n: number
  size: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  quality: 'auto' | 'low' | 'medium' | 'high'
  background: 'auto' | 'opaque' | 'transparent'
}

export interface CodexCapabilitySettingsProps {
  rpc: CodexAuthRpcClient
  t: (key: CodexAuthKey) => string
  subscribe: (listener: () => void) => () => void
  searchScope: SettingsScope<SearchSettingsView>
  imageScope: SettingsScope<ImageSettingsView>
}

type LoadState = 'loading' | 'ready' | 'error'

/** One navigable GPT Auth section containing Auth/LLM, Search, and Image Creation cards. */
export function CodexCapabilitySettings({
  rpc,
  t,
  subscribe,
  searchScope,
  imageScope,
}: CodexCapabilitySettingsProps): ReactNode {
  const [status, setStatus] = useState<CodexAuthStatusView | null>(null)
  const [usage, setUsage] = useState<CodexUsageView | null>(null)
  const [usageBusy, setUsageBusy] = useState(true)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const search = useScope(searchScope)
  const image = useScope(imageScope)

  useEffect(() => subscribe(() => { setTick(value => value + 1) }), [subscribe])

  const load = useCallback(async () => {
    setRefreshBusy(true)
    setError(null)
    const minDelay = new Promise(resolve => setTimeout(resolve, 500))
    try {
      const [result] = await Promise.all([rpc.status(), minDelay])
      if (!result.ok) {
        setLoadState(previous => previous === 'ready' ? previous : 'error')
        setError(result.error.message || t('statusFailed'))
        return
      }
      setStatus(result.value.status)
      setLoadState('ready')
    } catch (cause) {
      setLoadState(previous => previous === 'ready' ? previous : 'error')
      setError(messageOf(cause, t('statusFailed')))
    } finally {
      setRefreshBusy(false)
    }
  }, [rpc, t])

  const loadUsage = useCallback(async () => {
    setUsageBusy(true)
    try {
      const result = await rpc.usage()
      if (result.ok) setUsage(result.value.usage)
    } catch {
      /* quota facts are optional */
    } finally {
      setUsageBusy(false)
    }
  }, [rpc])

  useEffect(() => { void load(); void loadUsage() }, [load, loadUsage, tick])

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

  const searchUnavailable = status?.configured !== true
  const imageUnavailable = status?.configured !== true || status.planType?.toLowerCase() === 'free'

  return (
    <section className={classes.bundle}>
      <header className={classes.bundleHeader}>
        <div>
          <div className={classes.bundleTitleLine}>
            <h1 className={classes.bundleTitle}>{t('title')}</h1>
            <StatusDot loadState={loadState} status={status} t={t} />
          </div>
          <p className={classes.bundleIntro}>{t('intro')}</p>
        </div>
      </header>

      <div className={classes.cards}>
        {/* Auth / Login Card */}
        <article className={classes.card}>
          <CardHeading title={t('authCardTitle')} intro={t('authCardIntro')} />
          <AuthBody status={status} usage={usage} usageBusy={usageBusy} loadState={loadState} t={t} />
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
              icon={(
                <span className={refreshBusy ? classes.spinIcon : classes.staticIcon}>
                  <IconRefreshOutline16 size={16} />
                </span>
              )}
              disabled={refreshBusy}
              onClick={() => { void load(); void loadUsage() }}
            >
              {refreshBusy ? t('refreshing') : t('refresh')}
            </Button>
          </div>
          <p className={classes.privacyNotice}>{t('privacyNotice')}</p>
        </article>

        {/* Web Search Card */}
        <article className={classes.card}>
          <CardHeading
            title={t('searchCardTitle')}
            intro={t('searchCardIntro')}
            badge={status !== null && !status.configured ? t('availableAfterLogin') : undefined}
            tone={status?.configured === false ? 'warning' : 'neutral'}
            action={search.value === undefined ? null : (
              <Switch
                label={t('enableSearch')}
                checked={search.value.enabled}
                disabled={!search.writable || searchUnavailable}
                onChange={next => { void writer(searchScope, setError, t)('enabled', next) }}
              />
            )}
          />
          <SettingsState snapshot={search} t={t}>
            {search.value === undefined ? null : (
              <SearchControls
                scope={searchScope}
                snapshot={search}
                t={t}
                unavailable={searchUnavailable}
                onError={setError}
              />
            )}
          </SettingsState>
        </article>

        {/* Image Creation Card */}
        <article className={classes.card}>
          <CardHeading
            title={t('imageCardTitle')}
            intro={t('imageCardIntro')}
            badge={status === null
              ? undefined
              : !status.configured
                ? t('availableAfterLogin')
                : status.planType?.toLowerCase() === 'free'
                  ? t('unavailableFree')
                  : undefined}
            tone={!status?.configured || status.planType?.toLowerCase() === 'free' ? 'warning' : 'neutral'}
            action={image.value === undefined ? null : (
              <Switch
                label={t('enableImage')}
                checked={image.value.enabled}
                disabled={!image.writable || imageUnavailable}
                onChange={next => { void writer(imageScope, setError, t)('enabled', next) }}
              />
            )}
          />
          <SettingsState snapshot={image} t={t}>
            {image.value === undefined ? null : (
              <ImageControls
                scope={imageScope}
                snapshot={image}
                t={t}
                unavailable={imageUnavailable}
                onError={setError}
              />
            )}
          </SettingsState>
        </article>
      </div>

      {error === null ? null : <p className={classes.error} role="alert">{error}</p>}
      {status?.available === true && !status.configured ? <p className={classes.hint}>{t('loginHint')}</p> : null}
    </section>
  )
}

function CardHeading({
  title,
  intro,
  badge,
  action,
  tone = 'neutral',
}: {
  title: string
  intro: string
  badge?: string | undefined
  action?: ReactNode
  tone?: 'neutral' | 'warning'
}): ReactNode {
  return (
    <header className={classes.cardHeader}>
      <div className={classes.cardIdentity}>
        <div className={classes.cardTitleLine}>
          <h2 className={classes.cardTitle}>{title}</h2>
          {badge === undefined ? null : <span className={classes.badge} data-tone={tone}>{badge}</span>}
        </div>
        <p className={classes.cardIntro}>{intro}</p>
      </div>
      {action !== undefined ? <div className={classes.cardAction}>{action}</div> : null}
    </header>
  )
}

function StatusDot({
  loadState,
  status,
  t,
}: {
  loadState: LoadState
  status: CodexAuthStatusView | null
  t: CodexCapabilitySettingsProps['t']
}): ReactNode {
  const state = loadState === 'loading'
    ? 'ongoing'
    : loadState === 'error' || status === null
      ? 'error'
      : status.configured
        ? 'done'
        : status.available
          ? 'warning'
          : 'error'
  const label = loadState === 'loading'
    ? t('refreshing')
    : status?.configured === true
      ? t('active')
      : status?.available === false
        ? t('notAvailable')
        : t('loggedOut')
  return (
    <span className={classes.titleDot} title={label} aria-label={label} role="status">
      <StateDot state={state} />
      <span className={classes.srOnly}>{label}</span>
    </span>
  )
}

function AuthBody({
  status,
  usage,
  usageBusy,
  loadState,
  t,
}: {
  status: CodexAuthStatusView | null
  usage: CodexUsageView | null
  usageBusy: boolean
  loadState: LoadState
  t: CodexCapabilitySettingsProps['t']
}): ReactNode {
  if (status === null) {
    if (loadState === 'loading') {
      return (
        <div className={classes.authDashboard}>
          <dl className={classes.facts}>
            <Fact label={t('plan')} value={<span className={classes.skeletonInlineValue} />} />
            <Fact label={t('weeklyReset')} value={<span className={classes.skeletonInlineValue} />} />
          </dl>
          <div className={classes.quotaContainer}>
            <div className={classes.quotaInfo}>
              <span className={classes.quotaLabel}>{t('quotaRemaining')}</span>
              <span className={classes.quotaQuerying}>
                <span className={classes.queryingSpinner} aria-hidden="true" />
                <span>{t('queryingQuota')}</span>
              </span>
            </div>
            <div className={classes.progressTrack}>
              <div className={classes.shimmerTrack} aria-hidden="true" />
            </div>
          </div>
        </div>
      )
    }
    return null
  }

  const remainingPercent = usage?.weeklyRemainingPercent
  const showQuerying = usageBusy && remainingPercent === undefined

  return (
    <div className={classes.authDashboard}>
      <dl className={classes.facts}>
        <Fact label={t('plan')} value={status.planType === undefined ? t('unknownPlan') : `${titleCase(status.planType)} plan`} />
        <Fact
          label={t('weeklyReset')}
          value={
            usage?.weeklyResetAt !== undefined
              ? localDate(usage.weeklyResetAt)
              : usageBusy
                ? <span className={classes.skeletonInlineValue} />
                : '—'
          }
        />
      </dl>
      <div className={classes.quotaContainer}>
        <div className={classes.quotaInfo}>
          <span className={classes.quotaLabel}>{t('quotaRemaining')}</span>
          {showQuerying ? (
            <span className={classes.quotaQuerying}>
              <span className={classes.queryingSpinner} aria-hidden="true" />
              <span>{t('queryingQuota')}</span>
            </span>
          ) : remainingPercent !== undefined ? (
            <span
              className={classes.quotaValue}
              data-tone={quotaTone(remainingPercent)}
            >
              {remainingPercent}%
            </span>
          ) : (
            <span className={classes.quotaValue}>—</span>
          )}
        </div>
        <div className={classes.progressTrack}>
          {showQuerying ? (
            <div className={classes.shimmerTrack} aria-hidden="true" />
          ) : remainingPercent !== undefined ? (
            <div
              className={classes.progressFill}
              data-tone={quotaTone(remainingPercent)}
              style={{ width: `${Math.max(0, Math.min(100, remainingPercent))}%` }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className={classes.fact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function SettingsState<T>({
  snapshot,
  t,
  children,
}: {
  snapshot: SettingsScopeSnapshot<T>
  t: CodexCapabilitySettingsProps['t']
  children: ReactNode
}): ReactNode {
  if (snapshot.status === 'loading') {
    return (
      <div className={classes.skeletonFormRows} role="status" aria-live="polite" aria-busy="true">
        <span className={classes.srOnly}>{t('settingsLoading')}</span>
        <div className={classes.skeletonRow} aria-hidden="true" />
        <div className={classes.skeletonRow} aria-hidden="true" />
        <div className={classes.skeletonRow} aria-hidden="true" />
        <div className={classes.skeletonRow} aria-hidden="true" />
      </div>
    )
  }
  if (snapshot.status === 'unavailable' || snapshot.value === undefined) {
    return <p className={classes.loading}>{t('settingsUnavailable')}</p>
  }
  return children
}

function SearchControls({
  scope,
  snapshot,
  t,
  unavailable,
  onError,
}: {
  scope: SettingsScope<SearchSettingsView>
  snapshot: SettingsScopeSnapshot<SearchSettingsView>
  t: CodexCapabilitySettingsProps['t']
  unavailable: boolean
  onError: (message: string | null) => void
}): ReactNode {
  const value = snapshot.value as SearchSettingsView
  const disabled = !snapshot.writable || unavailable || !value.enabled
  const write = writer(scope, onError, t)
  return (
    <div className={classes.formRows} data-dimmed={!value.enabled || unavailable}>
      <Control label={t('searchMode')}>
        <select aria-label={t('searchMode')} value={value.mode} disabled={disabled} onChange={event => { void write('mode', event.target.value) }}>
          <option value="live">{t('live')}</option><option value="cached">{t('cached')}</option><option value="indexed">{t('indexed')}</option>
        </select>
      </Control>
      <Control label={t('contextSize')}>
        <select aria-label={t('contextSize')} value={value.contextSize} disabled={disabled} onChange={event => { void write('contextSize', event.target.value) }}>
          <option value="low">{t('low')}</option><option value="medium">{t('medium')}</option><option value="high">{t('high')}</option>
        </select>
      </Control>
      <Control label={t('fallbackModel')}>
        <input aria-label={t('fallbackModel')} value={value.fallbackModel} disabled={disabled} onChange={event => { void write('fallbackModel', event.target.value) }} />
      </Control>
      <Control label={t('maxOutputTokens')}>
        <input aria-label={t('maxOutputTokens')} type="number" min={1} step={1} value={value.maxOutputTokens} disabled={disabled} onChange={event => { void write('maxOutputTokens', Number(event.target.value)) }} />
      </Control>
    </div>
  )
}

function ImageControls({
  scope,
  snapshot,
  t,
  unavailable,
  onError,
}: {
  scope: SettingsScope<ImageSettingsView>
  snapshot: SettingsScopeSnapshot<ImageSettingsView>
  t: CodexCapabilitySettingsProps['t']
  unavailable: boolean
  onError: (message: string | null) => void
}): ReactNode {
  const value = snapshot.value as ImageSettingsView
  const disabled = !snapshot.writable || unavailable || !value.enabled
  const write = writer(scope, onError, t)
  return (
    <div className={classes.formRows} data-dimmed={!value.enabled || unavailable}>
      <Control label={t('imageModel')}>
        <input aria-label={t('imageModel')} value={value.model} disabled={disabled} onChange={event => { void write('model', event.target.value) }} />
      </Control>
      <Control label={t('defaultImageCount')}>
        <select aria-label={t('defaultImageCount')} value={value.n} disabled={disabled} onChange={event => { void write('n', Number(event.target.value)) }}>
          {Array.from({ length: 10 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </Control>
      <Control label={t('defaultSize')}>
        <select aria-label={t('defaultSize')} value={value.size} disabled={disabled} onChange={event => { void write('size', event.target.value) }}>
          <option value="auto">{t('automatic')}</option><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option>
        </select>
      </Control>
      <Control label={t('defaultQuality')}>
        <select aria-label={t('defaultQuality')} value={value.quality} disabled={disabled} onChange={event => { void write('quality', event.target.value) }}>
          <option value="auto">{t('automatic')}</option><option value="low">{t('low')}</option><option value="medium">{t('medium')}</option><option value="high">{t('high')}</option>
        </select>
      </Control>
      <Control label={t('defaultBackground')}>
        <select aria-label={t('defaultBackground')} value={value.background} disabled={disabled} onChange={event => { void write('background', event.target.value) }}>
          <option value="auto">{t('automatic')}</option><option value="opaque">{t('opaque')}</option><option value="transparent">{t('transparent')}</option>
        </select>
      </Control>
    </div>
  )
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  return (
    <label className={classes.switchToggle} title={label}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange(event.target.checked) }}
      />
      <span className={classes.switchSlider} />
    </label>
  )
}

function Control({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={classes.formRow}>
      <span className={classes.formLabel}>{label}</span>
      <div className={classes.formField}>{children}</div>
    </div>
  )
}

function useScope<T>(scope: SettingsScope<T>): SettingsScopeSnapshot<T> {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function writer<T>(
  scope: SettingsScope<T>,
  onError: (message: string | null) => void,
  t: CodexCapabilitySettingsProps['t'],
): (field: string, value: unknown) => Promise<void> {
  return async (field, value) => {
    onError(null)
    try { await scope.set(field, value) } catch (error) { onError(messageOf(error, t('writeFailed'))) }
  }
}

function localDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]?.toUpperCase() + value.slice(1)
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return fallback
}

function quotaTone(percent: number): 'error' | 'warning' | 'normal' {
  if (percent < 30) return 'error'
  if (percent <= 60) return 'warning'
  return 'normal'
}
