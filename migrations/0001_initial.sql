CREATE TABLE IF NOT EXISTS relay_states (
    relay_id INTEGER PRIMARY KEY CHECK (relay_id BETWEEN 1 AND 8),
    desired_state INTEGER NOT NULL DEFAULT 0 CHECK (desired_state IN (0, 1)),
    reported_state INTEGER NOT NULL DEFAULT 0 CHECK (reported_state IN (0, 1)),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relay_id INTEGER NOT NULL CHECK (relay_id BETWEEN 1 AND 8),
    desired_state INTEGER NOT NULL CHECK (desired_state IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    acknowledged_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_commands_pending
ON commands (acknowledged_at, id);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO relay_states (relay_id)
VALUES (1), (2), (3), (4), (5), (6), (7), (8);
