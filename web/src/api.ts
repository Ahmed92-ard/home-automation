import type { Relay, RelayState, StateResponse } from './types'

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
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection.')
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {}

  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, body))
  return body
}

function messageFor(status: number, body: unknown): string {
  if (status === 401) return 'Your session has expired. Please sign in again.'
  if (status === 403) return 'The server refused this request (403).'
  if (status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (status >= 500) return 'The server had a problem. Try again shortly.'
  const msg = body && typeof body === 'object'
    ? (body as Record<string, unknown>).error : null
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
    throw new ApiError(0, 'Local ESP32 API is unavailable.')
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {}

  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, body))
  return body
}

// Session validation must always use Cloudflare.
export async function getCloudState(signal?: AbortSignal): Promise<Relay[]> {
  return normalizeRelays(await request('/api/state', {}, signal))
}

// Prefer local ESP32 state, falling back to Cloudflare.
export async function getState(signal?: AbortSignal): Promise<Relay[]> {
  try {
    return normalizeRelays(await localRequest('/api/local/state', {}, signal))
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return getCloudState(signal)
  }
}

async function setCloudRelay(id: number, state: RelayState): Promise<void> {
  await request(`/api/relays/${id}`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  })
}

export async function setRelay(id: number, state: RelayState): Promise<void> {
  let localSucceeded = false

  try {
    await localRequest('/api/local/relay', {
      method: 'POST',
      body: JSON.stringify({ relay_id: id, state }),
    })
    localSucceeded = true
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
  }

  try {
    // Wait for Cloudflare to accept the same desired state.
    // Do not silently report success if cloud synchronization fails.
    await setCloudRelay(id, state)
  } catch (e) {
    if (localSucceeded) {
      console.error('Relay changed locally, but Cloudflare sync failed:', e)
      throw new Error(
        `Relay ${id} changed locally, but cloud synchronization failed. ` +
        `Check your connection and retry the command.`
      )
    }
    throw e
  }
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
