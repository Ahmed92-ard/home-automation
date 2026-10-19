import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const DEVICE_TOKEN = env.DEVICE_TOKEN;

async function request(
  path: string,
  options: RequestInit = {},
  base = "https://example.com",
) {
  return SELF.fetch(new Request(`${base}${path}`, options));
}

async function login() {
  const response = await request("/api/login", {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: env.AUTH_USERNAME,
      password: env.AUTH_PASSWORD,
    }),
  });

  expect(response.status).toBe(200);

  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toBeTruthy();

  return cookie!.split(";")[0];
}

async function deviceRequest(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${DEVICE_TOKEN}`);

  return request(path, { ...options, headers });
}

describe("Home automation API", () => {
  beforeEach(async () => {
    await env.home_automation_db.prepare(`
      CREATE TABLE IF NOT EXISTS relay_states (
        relay_id INTEGER PRIMARY KEY CHECK (relay_id BETWEEN 1 AND 8),
        desired_state INTEGER NOT NULL DEFAULT 0 CHECK (desired_state IN (0, 1)),
        reported_state INTEGER NOT NULL DEFAULT 0 CHECK (reported_state IN (0, 1)),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();

    await env.home_automation_db.prepare(`
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relay_id INTEGER NOT NULL CHECK (relay_id BETWEEN 1 AND 8),
        desired_state INTEGER NOT NULL CHECK (desired_state IN (0, 1)),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        acknowledged_at INTEGER
      )
    `).run();

    await env.home_automation_db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `).run();

    await env.home_automation_db.prepare(`
      INSERT OR IGNORE INTO relay_states (relay_id)
      VALUES (1), (2), (3), (4), (5), (6), (7), (8)
    `).run();

    await env.home_automation_db.prepare("DELETE FROM sessions").run();
    await env.home_automation_db.prepare("DELETE FROM commands").run();

    await env.home_automation_db.prepare(`
      UPDATE relay_states
      SET desired_state = 0, reported_state = 0, updated_at = unixepoch()
    `).run();
  });

  it("reports API health", async () => {
    const response = await request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects device requests without valid credentials", async () => {
    const response = await request("/api/device/commands");

    expect(response.status).toBe(401);
  });

  it("requires a login session to read relay state", async () => {
    const response = await request("/api/state");

    expect(response.status).toBe(401);
  });

  it("returns all eight relay states after login", async () => {
    const cookie = await login();

    const response = await request("/api/state", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);

    const body = await response.json() as {
      relays: Array<{ relay_id: number; desired_state: number }>;
    };

    expect(body.relays).toHaveLength(8);
    expect(body.relays.map((relay) => relay.relay_id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("only exposes the newest pending command for each relay", async () => {
    const cookie = await login();

    for (const state of [1, 0, 1]) {
      const response = await request("/api/relays/1", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state }),
      });

      expect(response.status).toBe(200);
    }

    const response = await deviceRequest("/api/device/commands");
    expect(response.status).toBe(200);

    const body = await response.json() as {
      commands: Array<{ id: number; relay_id: number; desired_state: number }>;
    };

    expect(body.commands).toHaveLength(1);
    expect(body.commands[0].relay_id).toBe(1);
    expect(body.commands[0].desired_state).toBe(1);

    const pending = await env.home_automation_db.prepare(
      `SELECT id, desired_state
       FROM commands
       WHERE relay_id = 1 AND acknowledged_at IS NULL`,
    ).all<{ id: number; desired_state: number }>();

    expect(pending.results).toHaveLength(1);
    expect(pending.results[0].desired_state).toBe(1);
    expect(pending.results[0].id).toBe(body.commands[0].id);
  });

  it("rejects a stale acknowledgement after a newer relay command is issued", async () => {
    const cookie = await login();

    const sendRelayCommand = async (state: 0 | 1) =>
      request("/api/relays/1", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://example.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state }),
      });

    await sendRelayCommand(1);

    const oldCommand = await env.home_automation_db.prepare(
      `SELECT id FROM commands
       WHERE relay_id = 1
       ORDER BY id DESC LIMIT 1`,
    ).first<{ id: number }>();

    expect(oldCommand).toBeTruthy();

    await sendRelayCommand(0);

    const staleAck = await deviceRequest("/api/device/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: oldCommand!.id,
        relayId: 1,
        state: 1,
      }),
    });

    expect(staleAck.status).toBe(409);

    const relay = await env.home_automation_db.prepare(
      "SELECT desired_state, reported_state FROM relay_states WHERE relay_id = 1",
    ).first<{ desired_state: number; reported_state: number }>();

    expect(relay?.desired_state).toBe(0);
    expect(relay?.reported_state).toBe(0);
  });

  it("rejects an acknowledgement for an invalid command", async () => {
    const response = await deviceRequest("/api/device/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: 999999,
        relayId: 1,
        state: 1,
      }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects malformed acknowledgement data", async () => {
    const response = await deviceRequest("/api/device/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandId: "not-an-id",
        relayId: 1,
        state: 1,
      }),
    });

    expect(response.status).toBe(400);
  });
});
