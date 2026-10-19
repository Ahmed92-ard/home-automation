export type RelayState = 0 | 1

export interface Relay {
  relay_id: number
  desired_state: RelayState
  /** null/undefined means the ESP32 has not reported yet. */
  reported_state: RelayState | null
  updated_at: number | null
}

export interface StateResponse {
  relays: Relay[]
}
