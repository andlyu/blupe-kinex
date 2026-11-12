CREATE TABLE runs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL,
 runner_name TEXT NOT NULL, runner_email TEXT NOT NULL, prompt TEXT NOT NULL,
 duration_s INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, active_slot INTEGER UNIQUE,
 stop_requested INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE runner (id INTEGER PRIMARY KEY CHECK (id=1), heartbeat_at INTEGER NOT NULL, status TEXT NOT NULL);
