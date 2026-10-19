import type { Relay, RelayState, StateResponse } from './types'

export type ControlMode = 'local' | 'cloud'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const LOCAL_API_URL = (import.meta.env.VITE_LOCAL_API_URL ?? 'http://192.168.31.182').replace(/\/$/, '')
const LOCAL_API_KEY = import.meta.env.VITE_LOCAL_API_KEY ?? ''
const SYNC_QUEUE_KEY = 'hc.cloudSyncQueue'

type QueuedSync = { state: RelayState; version: number }
type SyncQueue = Record<string, QueuedSync>
let cloudOperationChain: Promise<unknown> = Promise.resolve()

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'Cannot reach Cloudflare. Check your internet connection.')
  }

  let body: unknown = null
  try { body = await res.json() } catch {}
  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, body))
  return body
}

function messageFor(status: number, body: unknown): string {
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return 'The server refused this request (403).'
  if (status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (status >= 500) return 'The server had a problem. Try again shortly.'
  const msg = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null
  return typeof msg === 'string' && msg.length < 120 ? msg : `Request failed (${status}).`
}

const toState = (v: unknown): RelayState => Number(v) === 1 ? 1 : 0

function normalizeRelays(data: unknown): Relay[] {
  const list = data && typeof data === 'object' &&
    Array.isArray((data as Partial<StateResponse>).relays)
    ? (data as Partial<StateResponse>).relays!
    : []
  return list.map((r) => ({
    relay_id: Number(r.relay_id),
    desired_state: toState(r.desired_state),
    reported_state: r.reported_state == null ? null : toState(r.reported_state),
    updated_at: typeof r.updated_at === 'number' ? r.updated_at : null,
  })).sort((a, b) => a.relay_id - b.relay_id)
}

async function localRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  if (!LOCAL_API_KEY) throw new ApiError(0, 'Local API key is not configured.')
  let res: Response
  try {
    res = await fetch(`${LOCAL_API_URL}${path}`, {
      ...init,
      signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'X-LAN-Key': LOCAL_API_KEY,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'Local ESP32 is unavailable. Check Wi-Fi and the local API.')
  }
  let body: unknown = null
  try { body = await res.json() } catch {}
  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, body))
  return body
}

// Login/session validation always uses Cloudflare.
export async function getCloudState(signal?: AbortSignal): Promise<Relay[]> {
  return normalizeRelays(await request('/api/state', {}, signal))
}

export async function getLocalState(signal?: AbortSignal): Promise<Relay[]> {
  await localRequest('/api/local/health', {}, signal)
  return normalizeRelays(await localRequest('/api/local/state', {}, signal))
}

export async function checkModeConnection(mode: ControlMode): Promise<Relay[]> {
  return mode === 'local' ? getLocalState() : getCloudState()
}

export async function getState(mode: ControlMode, signal?: AbortSignal): Promise<Relay[]> {
  return mode === 'local' ? getLocalState(signal) : getCloudState(signal)
}

async function setCloudRelay(id: number, state: RelayState): Promise<void> {
  await request(`/api/relays/${id}`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  })
}

function readSyncQueue(): SyncQueue {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) as SyncQueue : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSyncQueue(queue: SyncQueue): void {
  try { localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue)) } catch {
    // Sync still works for this page session; persistence may be unavailable.
  }
}

function serializeCloud<T>(operation: () => Promise<T>): Promise<T> {
  const run = cloudOperationChain.then(operation, operation) as Promise<T>
  cloudOperationChain = run.catch(() => undefined)
  return run
}

export function hasPendingCloudSync(): boolean {
  return Object.keys(readSyncQueue()).length > 0
}

export async function flushPendingCloudSync(): Promise<void> {
  await serializeCloud(async () => {
    // Continue until the queue is empty. If a relay changes during a request,
    // the newest queued value is sent after the in-flight request completes.
    for (;;) {
      const queue = readSyncQueue()
      const entry = Object.entries(queue).sort((a, b) => a[1].version - b[1].version)[0]
      if (!entry) return
      const [key, item] = entry
      await setCloudRelay(Number(key), item.state)
      const latest = readSyncQueue()
      if (latest[key]?.version === item.version) {
        delete latest[key]
        writeSyncQueue(latest)
      }
    }
  })
}

function queueCloudSync(id: number, state: RelayState): void {
  const queue = readSyncQueue()
  queue[String(id)] = { state, version: Date.now() * 1000 + Math.floor(Math.random() * 1000) }
  writeSyncQueue(queue)
  void flushPendingCloudSync().catch((error) => {
    console.warn('Cloud sync remains pending:', error)
  })
}

export async function setRelay(mode: ControlMode, id: number, state: RelayState): Promise<void> {
  if (mode === 'local') {
    await localRequest('/api/local/relay', {
      method: 'POST',
      body: JSON.stringify({ relay_id: id, state }),
    })
    // The local action has succeeded. Cloud sync is deliberately non-blocking.
    queueCloudSync(id, state)
    return
  }

  // Remove any queued local retry now, before this operation waits in the
  // serialized cloud queue. A later Local-mode action can then enqueue a newer
  // value without being accidentally deleted by this older Cloud operation.
  const queue = readSyncQueue()
  delete queue[String(id)]
  writeSyncQueue(queue)
  await serializeCloud(async () => {
    await setCloudRelay(id, state)
  })
}

export async function login(username: string, password: string): Promise<void> {
  await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/api/logout', { method: 'POST' })
}
