import { Database } from "bun:sqlite";
import { join } from "node:path";

// Tests set MOOR_DB_PATH=":memory:" to run against a transient SQLite DB without
// touching the dev/prod file. Default path is unchanged for normal startup.
const DB_PATH = process.env.MOOR_DB_PATH ?? join(import.meta.dir, "..", "..", "data", "moor.db");

const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    github_url TEXT,
    branch TEXT DEFAULT 'main',
    dockerfile TEXT DEFAULT 'Dockerfile',
    image_tag TEXT,
    container_id TEXT,
    status TEXT DEFAULT 'stopped',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS env_vars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(project_id, key)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron_id INTEGER REFERENCES crons(id) ON DELETE SET NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    duration_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS port_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    host_port INTEGER NOT NULL,
    container_port INTEGER NOT NULL,
    protocol TEXT DEFAULT 'tcp',
    UNIQUE(host_port, protocol)
  );

  -- #34 Phase B: async exec runs. Distinct from the runs table (which tracks
  -- cron and build runs) because the lifecycle is different: long-running,
  -- explicitly stoppable, with bounded output. state is one of:
  --   'running'   exec is in flight; in-memory map holds the kill handle
  --   'exited'    process completed naturally; exit_code is set
  --   'stopped'   killed by moor_exec_stop, kill confirmed (no survivors)
  --   'timed_out' safety timer (timeout_ms) expired; kill ran
  --   'error'     something went wrong (e.g. lost during restart, no handle)
  CREATE TABLE IF NOT EXISTS exec_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    stdout TEXT NOT NULL DEFAULT '',
    stderr TEXT NOT NULL DEFAULT '',
    stdout_total_bytes INTEGER NOT NULL DEFAULT 0,
    stderr_total_bytes INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL,
    killed_pid TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_exec_runs_project_started
    ON exec_runs(project_id, started_at);
`);

// #34 Phase B: orphan sweep. On moor restart, the in-memory map of active runs
// is lost — we can't kill or observe those processes anymore. Any exec_runs row
// still in 'running' state is from a prior process and has no path back to a
// terminal state, so mark it as error with an honest message.
db.exec(`
  UPDATE exec_runs
  SET state = 'error',
      error_message = 'process may have continued past moor restart; terminal state unknown',
      finished_at = datetime('now')
  WHERE state = 'running'
`);

// Migrations — add columns that may not exist in older databases
try {
  db.exec("ALTER TABLE projects ADD COLUMN docker_image TEXT");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN domain TEXT");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN domain_port INTEGER");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN restart_policy TEXT DEFAULT 'unless-stopped'");
} catch {
  // Column already exists
}

export default db;
