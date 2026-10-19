import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, login } from './api'
import type { Relay, RelayState } from './types'

/* ---------- small pieces ---------- */

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#16224A" />
      <path d="M20.5 22.5a16.5 16.5 0 1 0 23 0" fill="none" stroke="#4C7DFF" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M32 12v18" stroke="#5EE0A0" strokeWidth="4.6" strokeLinecap="round" />
    </svg>
  )
}

function PowerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3v8" />
      <path d="M7.5 6.8a7.5 7.5 0 1 0 9 0" />
    </svg>
  )
}

function RefreshIcon({ spin }: { spin: boolean }) {
  return (
    <svg className={spin ? 'spin' : ''} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.3-4.5L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.5L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  )
}

/** Status of one relay, derived only from what the device has reported. */
export function view(r: Relay) {
  const known = r.reported_state !== null
  return {
    known,
    on: r.reported_state === 1,
    pending: known && r.reported_state !== r.desired_state,
  }
}

const label = (s: RelayState | null) => (s === null ? 'No report' : s ? 'ON' : 'OFF')

export function ageText(sec: number | null, nowMs: number): string {
  if (sec === null) return 'no timestamp'
  const d = Math.max(0, Math.round(nowMs / 1000 - sec))
  if (d < 5) return 'just now'
  if (d < 60) return `${d}s ago`
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

/* ---------- the eight-segment bus strip (the one signature element) ---------- */

export function BusStrip({ relays, intro }: { relays: Relay[] | null; intro?: boolean }) {
  return (
    <ol className={`strip${intro ? ' intro' : ''}`} aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => {
        const r = relays?.find((x) => x.relay_id === i + 1)
        const v = r ? view(r) : null
        const s = !v ? 'idle' : v.pending ? 'pending' : !v.known ? 'unknown' : v.on ? 'on' : 'off'
        return (
          <li key={i} className={`seg ${s}`} style={{ ['--i' as string]: i }}>
            {i + 1}
          </li>
        )
      })}
    </ol>
  )
}

/* ---------- login ---------- */

export function Login({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errId = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      await login(username.trim(), password)
      setPassword('')
      onSuccess()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect username or password.' : err instanceof Error ? err.message : 'Sign-in failed.')
      setLoading(false)
    }
  }

  const msg = error ?? notice ?? null
  return (
    <main className="login">
      <div className="login-inner">
        <div className="brand">
          <Logo size={40} />
          <span>Home Control</span>
        </div>
        <BusStrip relays={null} intro />
        <h1 className="login-title">Sign in to your board.</h1>
        <form onSubmit={submit} noValidate aria-describedby={msg ? errId : undefined}>
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={loading} />
          </label>
          <label className="field">
            <span>Password</span>
            <span className="pw">
              <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required disabled={loading} />
              <button type="button" className="ghost sm" onClick={() => setShow((s) => !s)} aria-pressed={show} disabled={loading}>
                {show ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>
          {msg && (
            <p id={errId} className={error ? 'form-msg error' : 'form-msg'} role={error ? 'alert' : 'status'}>
              {msg}
            </p>
          )}
          <button className="primary wide" type="submit" disabled={loading || !username.trim() || !password}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="foot">An internet connection is required to control the relays.</p>
      </div>
    </main>
  )
}

/* ---------- header, summary ---------- */

export function Header(p: { statusText: string; statusKind: 'ok' | 'warn' | 'bad' | 'idle'; refreshing: boolean; onRefresh: () => void; onSignOut: () => void; signingOut: boolean }) {
  return (
    <header className="top">
      <div className="brand">
        <Logo />
        <span>Home Control</span>
      </div>
      <div className="top-actions">
        <span className={`pill ${p.statusKind}`} role="status">
          <i aria-hidden="true" />
          {p.statusText}
        </span>
        <button className="icon" onClick={p.onRefresh} disabled={p.refreshing} aria-label="Refresh relay states" title="Refresh">
          <RefreshIcon spin={p.refreshing} />
        </button>
        <button className="ghost" onClick={p.onSignOut} disabled={p.signingOut}>
          {p.signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </header>
  )
}

export function Summary({ relays }: { relays: Relay[] | null }) {
  const vs = (relays ?? []).map(view)
  const on = vs.filter((v) => v.known && v.on).length
  const off = vs.filter((v) => v.known && !v.on).length
  const pending = vs.filter((v) => v.pending).length
  const unknown = vs.filter((v) => !v.known).length
  const stat = (n: number | string, name: string, cls = '') => (
    <div className={`stat ${cls}`}>
      <dd>{relays ? n : '–'}</dd>
      <dt>{name}</dt>
    </div>
  )
  return (
    <section className="summary" aria-label="Summary">
      <BusStrip relays={relays} />
      <dl className="stats">
        {stat(8, 'Channels')}
        {stat(on, 'Confirmed on', 'on')}
        {stat(off, 'Confirmed off')}
        {stat(pending, 'Waiting for device', pending ? 'pending' : '')}
      </dl>
      {unknown > 0 && <p className="note">{unknown} {unknown === 1 ? 'channel has' : 'channels have'} not reported yet.</p>}
    </section>
  )
}

/* ---------- relay card ---------- */

const NAMES_KEY = 'hc.relayNames' // custom labels only; no credentials or tokens

function loadNames(): Record<number, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') as Record<number, string>
  } catch {
    return {}
  }
}

export function useNames() {
  const [names, setNames] = useState<Record<number, string>>(loadNames)
  const save = (id: number, name: string) =>
    setNames((n) => {
      const next = { ...n }
      if (name.trim()) next[id] = name.trim().slice(0, 24)
      else delete next[id]
      try {
        localStorage.setItem(NAMES_KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable: name just won't persist */
      }
      return next
    })
  return [names, save] as const
}

export function RelayCard(p: { relay: Relay; name?: string; busy: boolean; error?: string; nowMs: number; onCommand: (s: RelayState) => void; onRename: (n: string) => void }) {
  const { relay: r } = p
  const v = view(r)
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const state = !v.known ? 'unknown' : v.on ? 'on' : 'off'
  const badge = !v.known ? 'No report' : v.on ? 'ON' : 'OFF'
  const title = `Relay ${r.relay_id}`

  const finish = (save: boolean) => {
    if (save && input.current) p.onRename(input.current.value)
    setEditing(false)
  }

  return (
    <article className={`relay ${state}${v.pending ? ' is-pending' : ''}`} aria-busy={p.busy}>
      <div className="relay-top">
        <span className="power" aria-hidden="true">
          <PowerIcon />
        </span>
        <span className={`badge ${state}`}>{badge}</span>
      </div>

      <div className="relay-name">
        {editing ? (
          <input
            ref={input}
            className="rename"
            defaultValue={p.name ?? ''}
            placeholder={title}
            maxLength={24}
            aria-label={`Name for ${title}`}
            onBlur={() => finish(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finish(true)
              if (e.key === 'Escape') finish(false)
            }}
          />
        ) : (
          <button className="name-btn" onClick={() => setEditing(true)} aria-label={`${p.name ? p.name + ', ' : ''}${title}. Rename`}>
            <strong>{p.name || title}</strong>
            {p.name && <span>{title}</span>}
          </button>
        )}
      </div>

      <dl className="states">
        <div>
          <dt>Requested</dt>
          <dd>{label(r.desired_state)}</dd>
        </div>
        <div>
          <dt>Reported</dt>
          <dd className={state}>{label(r.reported_state)}</dd>
        </div>
      </dl>

      <p className={`hint${v.pending ? ' pending' : ''}`} role="status">
        {p.busy ? 'Sending command…' : v.pending ? `Waiting for the device to confirm ${label(r.desired_state)}` : !v.known ? 'No report from the device yet' : `Updated ${ageText(r.updated_at, p.nowMs)}`}
      </p>

      <div className="seg-ctl" role="group" aria-label={`${title} command`}>
        <button className="off" aria-pressed={r.desired_state === 0} disabled={p.busy} onClick={() => p.onCommand(0)}>
          Off
        </button>
        <button className="on" aria-pressed={r.desired_state === 1} disabled={p.busy} onClick={() => p.onCommand(1)}>
          On
        </button>
      </div>

      {p.error && (
        <p className="card-error" role="alert">
          {p.error}
        </p>
      )}
    </article>
  )
}
