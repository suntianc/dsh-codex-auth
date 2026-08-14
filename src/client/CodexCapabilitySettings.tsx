/** Unified three-card settings surface for the Codex Capability Bundle. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconRefreshOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexAuthRpcClient, CodexAuthStatusView } from '../rpc-contract.ts'
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
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const search = useScope(searchScope)
  const image = useScope(imageScope)

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

  return (
    <section className={classes.bundle}>
      <header className={classes.bundleHeader}>
        <div>
          <h1 className={classes.bundleTitle}>{t('title')}</h1>
          <p className={classes.bundleIntro}>{t('intro')}</p>
        </div>
        <StatusPill loadState={loadState} status={status} t={t} />
      </header>

      <div className={classes.cards}>
        <article className={classes.card}>
          <CardHeading title={t('authCardTitle')} intro={t('authCardIntro')} index="01" />
          <AuthBody status={status} loadState={loadState} t={t} />
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
        </article>

        <article className={classes.card}>
          <CardHeading
            title={t('searchCardTitle')}
            intro={t('searchCardIntro')}
            index="02"
            badge={status === null ? undefined : status.configured ? t('deploymentWide') : t('availableAfterLogin')}
            tone={status?.configured === false ? 'warning' : 'neutral'}
          />
          <SettingsState snapshot={search} t={t}>
            {search.value === undefined ? null : <SearchControls
              scope={searchScope}
              snapshot={search}
              t={t}
              unavailable={status?.configured !== true}
              onError={setError}
            />}
          </SettingsState>
        </article>

        <article className={classes.card}>
          <CardHeading
            title={t('imageCardTitle')}
            intro={t('imageCardIntro')}
            index="03"
            badge={status === null
              ? undefined
              : !status.configured
                ? t('availableAfterLogin')
                : status.planType?.toLowerCase() === 'free'
                  ? t('unavailableFree')
                  : t('entitlementOnUse')}
            tone={!status?.configured || status.planType?.toLowerCase() === 'free' ? 'warning' : 'neutral'}
          />
          <SettingsState snapshot={image} t={t}>
            {image.value === undefined ? null : <ImageControls
              scope={imageScope}
              snapshot={image}
              t={t}
              unavailable={status?.configured !== true || status.planType?.toLowerCase() === 'free'}
              onError={setError}
            />}
          </SettingsState>
        </article>
      </div>

      {error === null ? null : <p className={classes.error} role="alert">{error}</p>}
      {status?.available === true && !status.configured ? <p className={classes.hint}>{t('loginHint')}</p> : null}
      <div className={classes.notice}>
        <p>{t('privacyNotice')}</p>
      </div>
    </section>
  )
}

function CardHeading({
  title,
  intro,
  index,
  badge,
  tone = 'neutral',
}: {
  title: string
  intro: string
  index: string
  badge?: string | undefined
  tone?: 'neutral' | 'warning'
}): ReactNode {
  return (
    <header className={classes.cardHeader}>
      <span className={classes.cardIndex}>{index}</span>
      <div className={classes.cardIdentity}>
        <div className={classes.cardTitleLine}>
          <h2 className={classes.cardTitle}>{title}</h2>
          {badge === undefined ? null : <span className={classes.badge} data-tone={tone}>{badge}</span>}
        </div>
        <p className={classes.cardIntro}>{intro}</p>
      </div>
    </header>
  )
}

function StatusPill({
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
  return <span className={classes.statusPill}><StateDot state={state} /><span>{label}</span></span>
}

function AuthBody({
  status,
  loadState,
  t,
}: {
  status: CodexAuthStatusView | null
  loadState: LoadState
  t: CodexCapabilitySettingsProps['t']
}): ReactNode {
  if (loadState === 'loading') return <p className={classes.loading}>{t('refreshing')}</p>
  if (status === null) return null
  return (
    <dl className={classes.facts}>
      {status.accountId === undefined ? null : <Fact label={t('accountId')} value={status.accountId} />}
      <Fact label={t('plan')} value={status.planType === undefined ? t('unknownPlan') : `${titleCase(status.planType)} plan`} />
      {status.authMode === undefined ? null : <Fact label={t('authMode')} value={status.authMode} />}
      {status.codexVersion === undefined ? null : <Fact label={t('codexVersion')} value={status.codexVersion} />}
      {status.tokenExpiresAt === undefined ? null : <Fact label={t('tokenExpiresAt')} value={localDate(status.tokenExpiresAt)} />}
      {status.lastRefreshAt === undefined ? null : <Fact label={t('lastRefreshAt')} value={localDate(status.lastRefreshAt)} />}
      <Fact label={t('credentialRef')} value={status.credentialRef} />
    </dl>
  )
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return <div className={classes.fact}><dt>{label}</dt><dd>{value}</dd></div>
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
  if (snapshot.status === 'loading') return <p className={classes.loading}>{t('settingsLoading')}</p>
  if (snapshot.status === 'unavailable' || snapshot.value === undefined) return <p className={classes.loading}>{t('settingsUnavailable')}</p>
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
  const disabled = !snapshot.writable || unavailable
  const write = writer(scope, onError, t)
  return (
    <div className={classes.controls}>
      <Switch label={t('enableSearch')} checked={value.enabled} disabled={disabled} onChange={next => { void write('enabled', next) }} />
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
  const disabled = !snapshot.writable || unavailable
  const write = writer(scope, onError, t)
  return (
    <div className={classes.controls}>
      <Switch label={t('enableImage')} checked={value.enabled} disabled={disabled} onChange={next => { void write('enabled', next) }} />
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
    <label className={classes.switchRow}>
      <span>{label}</span>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange(event.target.checked) }} />
    </label>
  )
}

function Control({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return <label className={classes.control}><span>{label}</span>{children}</label>
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
