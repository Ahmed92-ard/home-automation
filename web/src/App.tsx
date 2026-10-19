import { useEffect, useState } from 'react'
import { ApiError, getCloudState, logout } from './api'
import { ageText, BusStrip, Header, Login, RelayCard, Summary, useNames } from './components'
import { useRelays } from './useRelays'
import type { Relay } from './types'
import { registerSW } from 'virtual:pwa-register'

type Auth = { kind: 'checking' } | { kind: 'out'; notice?: string } | { kind: 'in'; initial: Relay[] | null }

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

  // Session check: /api/state succeeds only with a valid cookie.
  useEffect(() => {
    const ctl = new AbortController()
    getCloudState(ctl.signal)
      .then((initial) => setAuth({ kind: 'in', initial }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setAuth({ kind: 'out', notice: e instanceof ApiError && e.status !== 401 ? e.message : undefined })
      })
    return () => ctl.abort()
  }, [])

  // New frontend versions wait for the user to accept them.
  useEffect(() => {
    const updateSW = registerSW({ onNeedRefresh: () => setUpdate(() => () => void updateSW(true)) })
  }, [])

  if (auth.kind === 'checking')
    return (
      <main className="splash" aria-busy="true">
        <BusStrip relays={null} intro />
        <p>Checking your session…</p>
      </main>
    )

  return (
    <>
      {update && (
        <div className="update" role="status">
          <span>A new version is ready.</span>
          <button className="primary sm" onClick={update}>
            Update
          </button>
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
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const s = useRelays(initial, () => onSignedOut('Your session has expired. Please sign in again.'))

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!s.notice) return
    const t = setTimeout(s.clearNotice, 4500)
    return () => clearTimeout(t)
  }, [s.notice, s])

  async function signOut() {
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

  const status = !online
    ? { text: 'Offline', kind: 'bad' as const }
    : s.link === 'error'
      ? { text: 'Reconnecting…', kind: 'warn' as const }
      : s.link === 'loading'
        ? { text: 'Connecting…', kind: 'idle' as const }
        : { text: `Live · ${ageText(s.lastOk ? s.lastOk / 1000 : null, now)}`, kind: 'ok' as const }

  return (
    <div className="shell">
      <Header statusText={status.text} statusKind={status.kind} refreshing={s.refreshing} onRefresh={() => void s.refresh()} onSignOut={() => void signOut()} signingOut={signingOut} />

      <main>
        <section className="welcome">
          <h1>Everything under control.</h1>
          <p>Eight relay channels on one board. A channel shows ON only after the ESP32 reports it, so a queued command never looks like a switched relay.</p>
        </section>

        {(!online || s.linkError || signOutError) && (
          <p className="banner" role="alert">
            {!online ? 'You are offline. An internet connection is required to control the relays.' : (signOutError ?? s.linkError)}
          </p>
        )}

        <Summary relays={s.relays} />

        {s.relays === null ? (
          <p className="empty">Loading relay states…</p>
        ) : s.relays.length === 0 ? (
          <p className="empty">The server returned no relay channels. Pull to refresh or try again shortly.</p>
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

      <footer className="foot">An internet connection is required to control the relays.</footer>
      <div className="toast" role="status" aria-live="polite">
        {s.notice}
      </div>
    </div>
  )
}
