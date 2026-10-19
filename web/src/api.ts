import type { Relay, RelayState, StateResponse } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

async function request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection.')
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* empty or non-JSON body */
  }
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

const toState = (v: unknown): RelayState => (Number(v) === 1 ? 1 : 0)

export async function getState(signal?: AbortSignal): Promise<Relay[]> {
  const data = (await request('/api/state', {}, signal)) as Partial<StateResponse> | null
  const list = Array.isArray(data?.relays) ? data.relays : []
  return list
    .map((r) => ({
      relay_id: Number(r.relay_id),
      desired_state: toState(r.desired_state),
      reported_state: r.reported_state === null || r.reported_state === undefined ? null : toState(r.reported_state),
      updated_at: typeof r.updated_at === 'number' ? r.updated_at : null,
    }))
    .sort((a, b) => a.relay_id - b.relay_id)
}

export async function setRelay(id: number, state: RelayState): Promise<void> {
  await request(`/api/relays/${id}`, { method: 'POST', body: JSON.stringify({ state }) })
}

export async function login(username: string, password: string): Promise<void> {
  await request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export async function logout(): Promise<void> {
  await request('/api/logout', { method: 'POST' })
}
