import { useCallback, useEffect, useState } from 'react'
import { ApiError, checkModeConnection, getCloudState, getLocalState, logout } from './api'
import type { ControlMode } from './api'
import { ageText, BusStrip, Header, Login, RelayCard, Summary, useNames } from './components'
import { useRelays } from './useRelays'
import type { Relay } from './types'
import { registerSW } from 'virtual:pwa-register'

type Auth = { kind: 'checking' } | { kind: 'out'; notice?: string } | { kind: 'in'; initial: Relay[] | null }
type ModeCheck = { kind: 'checking' | 'ok' | 'error'; text: string }

const MODE_KEY = 'hc.controlMode'

function loadMode(): ControlMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'cloud' ? 'cloud' : 'local'
  } catch {
    return 'local'
  }
}

function saveMode(mode: ControlMode) {
  try { localStorage.setItem(MODE_KEY, mode) } catch {
    // The current selection still works for this page session.
  }
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

export default function App() {
  const [auth, setAuth] = useState<Auth>({ kind: 'checking' })
  const [update, setUpdate] = useState<null | (() => void)>(null)

  const isEsp32Host = window.location.hostname === '192.168.31.182'

  useEffect(() => {
    const ctl = new AbortController()
    const initialState = isEsp32Host
      ? getLocalState(ctl.signal)
      : getCloudState(ctl.signal)

    initialState
      .then((initial) => setAuth({ kind: 'in', initial }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setAuth({
          kind: 'out',
          notice: e instanceof ApiError && e.status !== 401
            ? e.message
            : undefined,
        })
      })

    return () => ctl.abort()
  }, [isEsp32Host])

  useEffect(() => {
    const updateSW = registerSW({ onNeedRefresh: () => setUpdate(() => () => void updateSW(true)) })
  }, [])

  if (auth.kind === 'checking') {
    return (
      <main className="splash" aria-busy="true">
        <BusStrip relays={null} intro />
        <p>Checking your session…</p>
      </main>
    )
  }

  return (
    <>
      {update && (
        <div className="update" role="status">
          <span>A new version is ready.</span>
          <button className="primary sm" onClick={update}>Update</button>
        </div>
      )}
      {auth.kind === 'out' ? (
        <Login notice={auth.notice} onSuccess={() => setAuth({ kind: 'in', initial: null })} />
      ) : (
        <Dashboard initial={auth.initial} onSignedOut={(notice) => setAuth({ kind: 'out', notice })} />
      )}
    </>
  )
}

function Dashboard({ initial, onSignedOut }: { initial: Relay[] | null; onSignedOut: (notice?: string) => void }) {
  const online = useOnline()
  const [names, rename] = useNames()
  const [mode, setMode] = useState<ControlMode>(loadMode)
  const [modeCheck, setModeCheck] = useState<ModeCheck>({ kind: 'checking', text: 'Checking selected mode…' })
  const [switchingMode, setSwitchingMode] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const s = useRelays(initial, mode, () => onSignedOut('Your session has expired. Please sign in again.'))

  const verifyMode = useCallback(async (candidate: ControlMode, commit: boolean) => {
    setSwitchingMode(true)
    setModeCheck({ kind: 'checking', text: `Checking ${candidate === 'local' ? 'ESP32 local' : 'Cloudflare'} connection…` })
    try {
      await checkModeConnection(candidate)
      if (commit) {
        setMode(candidate)
        saveMode(candidate)
      }
      setModeCheck({
        kind: 'ok',
        text: `${candidate === 'local' ? 'ESP32 local' : 'Cloudflare'} connection succeeded.`,
      })
    } catch (e) {
      setModeCheck({
        kind: 'error',
        text: `${candidate === 'local' ? 'Local ESP32' : 'Cloudflare'} connection failed: ${e instanceof Error ? e.message : 'Unknown connection error.'}`,
      })
    } finally {
      setSwitchingMode(false)
    }
  }, [])

  useEffect(() => {
    void verifyMode(mode, false)
    // Verify the persisted mode on dashboard startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!s.notice) return
    const t = setTimeout(s.clearNotice, 5000)
    return () => clearTimeout(t)
  }, [s.notice, s.clearNotice])

  async function signOut() {
    if (window.location.hostname === '192.168.31.182') {
      window.location.href = 'https://afautomation.vercel.app/'
      return
    }

    setSigningOut(true)
    setSignOutError(null)
    try {
      await logout()
      onSignedOut()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut()
      else {
        setSignOutError(e instanceof Error ? e.message : 'Could not sign out.')
        setSigningOut(false)
      }
    }
  }

  const status = !online && mode === 'cloud'
    ? { text: 'Offline', kind: 'bad' as const }
    : s.link === 'error'
      ? { text: 'Connection error', kind: 'bad' as const }
      : s.link === 'loading' || modeCheck.kind === 'checking'
        ? { text: 'Connecting…', kind: 'idle' as const }
        : { text: `${mode === 'local' ? 'Local' : 'Cloud'} live · ${ageText(s.lastOk ? s.lastOk / 1000 : null, now)}`, kind: 'ok' as const }

  return (
    <div className="shell">
      <Header statusText={status.text} statusKind={status.kind} refreshing={s.refreshing} onRefresh={() => void s.refresh()} onSignOut={() => void signOut()} signingOut={signingOut} />

      <main>
        <section className="welcome">
          <h1>Everything under control.</h1>
          <p>Choose where relay commands are sent. Local mode acts through the ESP32 first and synchronizes Cloudflare in the background.</p>
        </section>

        <section className="mode-panel" aria-label="Control mode">
          <div className="mode-heading">
            <div>
              <h2>Control mode</h2>
              <p>Mode selection is remembered on this device.</p>
            </div>
            <span className={`mode-status ${modeCheck.kind}`} role="status">{modeCheck.text}</span>
          </div>
          <div className="mode-switch" role="group" aria-label="Select control mode">
            <button
              className={mode === 'local' ? 'selected' : ''}
              aria-pressed={mode === 'local'}
              disabled={switchingMode}
              onClick={() => void verifyMode('local', true)}
            >
              Local · ESP32
            </button>
            <button
              className={mode === 'cloud' ? 'selected' : ''}
              aria-pressed={mode === 'cloud'}
              disabled={switchingMode}
              onClick={() => void verifyMode('cloud', true)}
            >
              Cloud · Cloudflare
            </button>
          </div>
          <p className={`sync-line ${s.cloudSyncStatus}`}>
            {s.cloudSyncStatus === 'synced'
              ? 'Cloud sync queue is clear.'
              : s.cloudSyncStatus === 'pending'
                ? 'Cloud sync pending. Local relay control remains available.'
                : 'Cloud sync failed. Pending changes will be retried automatically when connectivity returns.'}
          </p>
        </section>

        {((!online && mode === 'cloud') || s.linkError || signOutError || modeCheck.kind === 'error') && (
          <p className="banner" role="alert">
            {modeCheck.kind === 'error' ? modeCheck.text : !online && mode === 'cloud'
              ? 'You are offline. Cloud mode cannot send commands without an internet connection.'
              : (signOutError ?? s.linkError)}
          </p>
        )}

        <Summary relays={s.relays} />

        {s.relays === null ? (
          <p className="empty">Loading relay states…</p>
        ) : s.relays.length === 0 ? (
          <p className="empty">No relay channels were returned. Refresh or check the selected connection.</p>
        ) : (
          <section className="grid" aria-label="Relays">
            {s.relays.map((r) => (
              <RelayCard
                key={r.relay_id}
                relay={r}
                name={names[r.relay_id]}
                busy={s.busy.has(r.relay_id)}
                error={s.cardErrors[r.relay_id]}
                nowMs={now}
                onCommand={(state) => void s.command(r.relay_id, state)}
                onRename={(n) => rename(r.relay_id, n)}
              />
            ))}
          </section>
        )}
      </main>

      <footer className="foot">
        {mode === 'local'
          ? 'Local commands use the ESP32 on your LAN. Cloud synchronization runs separately.'
          : 'Cloud commands are queued through Cloudflare and confirmed by the ESP32.'}
      </footer>
      <div className="toast" role="status" aria-live="polite">{s.notice}</div>
    </div>
  )
}
