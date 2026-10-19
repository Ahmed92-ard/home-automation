import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getState, setRelay } from './api'
import type { Relay, RelayState } from './types'

const POLL_MS = 4000

export type Link = 'loading' | 'live' | 'error'

export function useRelays(initial: Relay[] | null, onUnauthorized: () => void) {
  const [relays, setRelays] = useState<Relay[] | null>(initial)
  const [link, setLink] = useState<Link>(initial ? 'live' : 'loading')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [lastOk, setLastOk] = useState<number | null>(initial ? Date.now() : null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({})
  const [notice, setNotice] = useState<string | null>(null)

  const inFlight = useRef(false)
  const cmdVersion = useRef(0) // bumps when a command completes; discards older in-flight reads
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  const refresh = useCallback(async () => {
    if (inFlight.current) return // never overlap requests
    inFlight.current = true
    setRefreshing(true)
    const version = cmdVersion.current
    try {
      const next = await getState()
      if (version !== cmdVersion.current) return
      setRelays(next)
      setLastOk(Date.now())
      setLink('live')
      setLinkError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) unauthorized.current()
      else {
        setLink('error')
        setLinkError(e instanceof Error ? e.message : 'Could not refresh.')
      }
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [])

  // Poll while mounted. Skips ticks while the tab is hidden; refreshes immediately when it returns.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) await refresh()
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    if (!initial) void tick()
    else timer = setTimeout(tick, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  const command = useCallback(
    async (id: number, state: RelayState) => {
      setBusy((b) => new Set(b).add(id))
      setCardErrors((e) => ({ ...e, [id]: '' }))
      try {
        await setRelay(id, state)
        cmdVersion.current += 1
        setRelays((rs) => rs && rs.map((r) => (r.relay_id === id ? { ...r, desired_state: state } : r)))
        setNotice(`Relay ${id} ${state ? 'ON' : 'OFF'} queued. Waiting for the device to confirm.`)
        void refresh()
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) unauthorized.current()
        else setCardErrors((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Command failed.' }))
      } finally {
        setBusy((b) => {
          const n = new Set(b)
          n.delete(id)
          return n
        })
      }
    },
    [refresh],
  )

  return { relays, link, linkError, lastOk, refreshing, busy, cardErrors, notice, clearNotice: () => setNotice(null), refresh, command }
}
