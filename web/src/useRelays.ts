import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, flushPendingCloudSync, getState, hasPendingCloudSync, setRelay } from './api'
import type { ControlMode } from './api'
import type { Relay, RelayState } from './types'

const POLL_MS = 4000
const SYNC_RETRY_MS = 8000

export type Link = 'loading' | 'live' | 'error'
export type CloudSyncStatus = 'synced' | 'pending' | 'failed'

export function useRelays(initial: Relay[] | null, mode: ControlMode, onUnauthorized: () => void) {
  const [relays, setRelays] = useState<Relay[] | null>(initial)
  const [link, setLink] = useState<Link>(initial ? 'live' : 'loading')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [lastOk, setLastOk] = useState<number | null>(initial ? Date.now() : null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [cloudSyncStatus, setCloudSyncStatus] = useState<CloudSyncStatus>(
    hasPendingCloudSync() ? 'pending' : 'synced',
  )

  const inFlight = useRef(false)
  const requestVersion = useRef(0)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const commandVersions = useRef<Record<number, number>>({})
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    const version = ++requestVersion.current
    const requestedMode = modeRef.current
    try {
      const next = await getState(requestedMode)
      if (version !== requestVersion.current || requestedMode !== modeRef.current) return
      setRelays((current) => {
        // Preserve optimistic local acceptance while a newer command is outstanding.
        return next.map((r) => {
          const currentRelay = current?.find((x) => x.relay_id === r.relay_id)
          const hasPendingCommand = (commandVersions.current[r.relay_id] ?? 0) > 0 &&
            currentRelay?.desired_state !== r.desired_state
          return hasPendingCommand && currentRelay ? currentRelay : r
        })
      })
      setLastOk(Date.now())
      setLink('live')
      setLinkError(null)
    } catch (e) {
      if (version !== requestVersion.current || requestedMode !== modeRef.current) return
      if (e instanceof ApiError && e.status === 401 && requestedMode === 'cloud') unauthorized.current()
      else {
        setLink('error')
        setLinkError(e instanceof Error ? e.message : 'Could not refresh.')
      }
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    // Invalidate any response started for the previous mode.
    requestVersion.current += 1
    void refresh()
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (!document.hidden) await refresh()
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
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
  }, [mode, refresh])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        await flushPendingCloudSync()
        if (!stopped) setCloudSyncStatus(hasPendingCloudSync() ? 'pending' : 'synced')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // A session may expire while local control is still working. Keep local mode usable.
          setCloudSyncStatus('failed')
        } else {
          if (!stopped) setCloudSyncStatus('failed')
        }
      }
      if (!stopped) timer = setTimeout(tick, SYNC_RETRY_MS)
    }
    void tick()
    const onOnline = () => { void tick() }
    window.addEventListener('online', onOnline)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  const clearNotice = useCallback(() => setNotice(null), [])

  const command = useCallback(async (id: number, state: RelayState) => {
    const commandMode = modeRef.current
    const version = (commandVersions.current[id] ?? 0) + 1
    commandVersions.current[id] = version
    setBusy((b) => new Set(b).add(id))
    setCardErrors((e) => ({ ...e, [id]: '' }))
    // Update the requested state immediately. Local mode commits after local HTTP acceptance.
    if (commandMode === 'local') {
      setRelays((rs) => rs?.map((r) => r.relay_id === id
        ? { ...r, desired_state: state }
        : r) ?? rs)
    }
    try {
      await setRelay(commandMode, id, state)
      if (commandVersions.current[id] !== version) return
      if (modeRef.current !== commandMode) {
        void refresh()
        return
      }
      setRelays((rs) => rs && rs.map((r) => r.relay_id === id
        ? { ...r, desired_state: state }
        : r))
      if (commandMode === 'local') {
        setCloudSyncStatus('pending')
        setNotice(`Relay ${id} accepted locally. Cloudflare sync is running in the background.`)
      } else {
        setNotice(`Relay ${id} command queued in Cloudflare. Waiting for ESP32 confirmation.`)
      }
      void refresh()
    } catch (e) {
      if (commandVersions.current[id] !== version) return
      if (modeRef.current !== commandMode) {
        void refresh()
        return
      }
      if (e instanceof ApiError && e.status === 401 && commandMode === 'cloud') unauthorized.current()
      else {
        setCardErrors((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Command failed.' }))
        // Refresh the selected backend to reconcile a failed command.
        void refresh()
      }
    } finally {
      if (commandVersions.current[id] === version) {
        delete commandVersions.current[id]
        setBusy((b) => {
          const n = new Set(b)
          n.delete(id)
          return n
        })
      }
    }
  }, [refresh])

  return {
    relays, link, linkError, lastOk, refreshing, busy, cardErrors, notice,
    cloudSyncStatus,
    clearNotice, refresh, command,
  }
}
