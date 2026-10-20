interface Env {
  home_automation_db: D1Database;
  AUTH_USERNAME: string;
  AUTH_PASSWORD: string;
  DEVICE_TOKEN: string;
  APP_ORIGIN?: string;
}

const SESSION_SECONDS = 60 * 60 * 24;
const COOKIE_NAME = "__Host-home_session";

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function fail(status: number, message: string) {
  return json({ error: message }, status);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  let accepted = false;

  if (origin) {
    try {
      const suppliedOrigin = new URL(origin).origin;
      const workerOrigin = new URL(request.url).origin;
      const appOrigin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : null;

      accepted =
        suppliedOrigin === workerOrigin ||
        (appOrigin !== null && suppliedOrigin === appOrigin);
    } catch {
      accepted = false;
    }
  }

  return accepted;
}
async function sessionIsValid(request: Request, env: Env): Promise<boolean> {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;

  const hash = await sha256(token);
  const row = await env.home_automation_db.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?"
  ).bind(hash, Math.floor(Date.now() / 1000)).first();

  return row !== null;
}

async function requireDevice(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/.exec(auth);
  if (!match) return false;

  // Compare digests without an early exit based on the token contents.
  const supplied = await sha256(match[1]);
  const expected = await sha256(env.DEVICE_TOKEN);
  let diff = supplied.length ^ expected.length;
  for (let i = 0; i < Math.min(supplied.length, expected.length); i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/health") {
    return json({ ok: true });
  }

  if (method === "POST" && path === "/api/login") {
    if (!sameOrigin(request, env)) return fail(403, "Invalid origin");

    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return fail(415, "Expected JSON");
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail(400, "Invalid JSON");
    }

    if (
      typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      body.username.length > 128 ||
      body.password.length > 256
    ) {
      return fail(400, "Invalid credentials format");
    }

    if (body.username !== env.AUTH_USERNAME || body.password !== env.AUTH_PASSWORD) {
      return fail(401, "Invalid username or password");
    }

    const token = randomToken();
    const hash = await sha256(token);
    const now = Math.floor(Date.now() / 1000);

    await env.home_automation_db.prepare(
      "DELETE FROM sessions WHERE expires_at <= ?"
    ).bind(now).run();

    await env.home_automation_db.prepare(
      "INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)"
    ).bind(hash, now + SESSION_SECONDS).run();

    return json(
      { ok: true },
      200,
      {
        "Set-Cookie":
          `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
      },
    );
  }

  if (method === "POST" && path === "/api/logout") {
    if (!sameOrigin(request, env)) return fail(403, "Invalid origin");

    const token = cookieValue(request, COOKIE_NAME);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await env.home_automation_db.prepare(
        "DELETE FROM sessions WHERE token_hash = ?"
      ).bind(await sha256(token)).run();
    }

    return json(
      { ok: true },
      200,
      { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
    );
  }

  if (path.startsWith("/api/device/")) {
    if (!(await requireDevice(request, env))) {
      return fail(401, "Invalid device credential");
    }

    if (method === "GET" && path === "/api/device/commands") {
      const result = await env.home_automation_db.prepare(
        `SELECT c.id, c.relay_id, c.desired_state
         FROM commands c
         WHERE c.acknowledged_at IS NULL
           AND c.id = (
             SELECT MAX(newest.id)
             FROM commands newest
             WHERE newest.relay_id = c.relay_id
               AND newest.acknowledged_at IS NULL
           )
         ORDER BY c.id ASC
         LIMIT 8`
      ).all();

      return json({ commands: result.results });
    }

    if (method === "POST" && path === "/api/device/ack") {
      let body: {
        commandId?: unknown;
        relayId?: unknown;
        state?: unknown;
      };

      try {
        body = await request.json();
      } catch {
        return fail(400, "Invalid JSON");
      }

      if (
        !Number.isSafeInteger(body.commandId) ||
        !Number.isInteger(body.relayId) ||
        (body.relayId as number) < 1 ||
        (body.relayId as number) > 8 ||
        (body.state !== 0 && body.state !== 1)
      ) {
        return fail(400, "Invalid acknowledgement");
      }

      const command = await env.home_automation_db.prepare(
        `SELECT id, relay_id, desired_state
         FROM commands
         WHERE id = ?
           AND acknowledged_at IS NULL
           AND id = (
             SELECT MAX(newest.id)
             FROM commands newest
             WHERE newest.relay_id = commands.relay_id
               AND newest.acknowledged_at IS NULL
           )`
      ).bind(body.commandId).first<{
        id: number;
        relay_id: number;
        desired_state: number;
      }>();

      if (
        !command ||
        command.relay_id !== body.relayId ||
        command.desired_state !== body.state
      ) {
        return fail(409, "Command mismatch or already acknowledged");
      }

      const now = Math.floor(Date.now() / 1000);
      const ackResults = await env.home_automation_db.batch([
        env.home_automation_db.prepare(
          `UPDATE commands SET acknowledged_at = ?
           WHERE id = ? AND acknowledged_at IS NULL
             AND id = (
               SELECT MAX(newest.id)
               FROM commands newest
               WHERE newest.relay_id = commands.relay_id
                 AND newest.acknowledged_at IS NULL
             )`
        ).bind(now, command.id),
        env.home_automation_db.prepare(
          `UPDATE relay_states SET reported_state = ?, updated_at = ?
           WHERE relay_id = ?
             AND changes() = 1
             AND EXISTS (
               SELECT 1 FROM commands acknowledged
               WHERE acknowledged.id = ?
                 AND acknowledged.acknowledged_at = ?
             )`
        ).bind(body.state, now, body.relayId, command.id, now),
      ]);

      if (ackResults[0].meta.changes !== 1) {
        return fail(409, "Command was superseded before acknowledgement");
      }

      return json({ ok: true });
    }

    return fail(404, "Device endpoint not found");
  }

  if (path.startsWith("/api/")) {
    if (!(await sessionIsValid(request, env))) {
      return fail(401, "Login required");
    }

    if (method === "GET" && path === "/api/state") {
      const result = await env.home_automation_db.prepare(
        `SELECT relay_id, desired_state, reported_state, updated_at
         FROM relay_states ORDER BY relay_id`
      ).all();

      return json({ relays: result.results });
    }

    const match = /^\/api\/relays\/([1-8])$/.exec(path);
    if (method === "POST" && match) {
      if (!sameOrigin(request, env)) return fail(403, "Invalid origin");

      let body: { state?: unknown };
      try {
        body = await request.json();
      } catch {
        return fail(400, "Invalid JSON");
      }

      if (body.state !== 0 && body.state !== 1) {
        return fail(400, "State must be 0 or 1");
      }

      const relayId = Number(match[1]);
      const now = Math.floor(Date.now() / 1000);

      await env.home_automation_db.batch([
        // Supersede older pending commands for this relay before inserting the latest request.
        env.home_automation_db.prepare(
          `UPDATE commands SET acknowledged_at = ?
           WHERE relay_id = ? AND acknowledged_at IS NULL`
        ).bind(now, relayId),
        env.home_automation_db.prepare(
          `UPDATE relay_states SET desired_state = ?, updated_at = ?
           WHERE relay_id = ?`
        ).bind(body.state, now, relayId),
        env.home_automation_db.prepare(
          `INSERT INTO commands (relay_id, desired_state, created_at)
           VALUES (?, ?, ?)`
        ).bind(relayId, body.state, now),
      ]);

      return json({ ok: true, relayId, desiredState: body.state });
    }
  }

  return fail(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Do not expose secrets, SQL details, or stack traces to clients.
      return fail(500, "Internal server error");
    }
  },
} satisfies ExportedHandler<Env>;
