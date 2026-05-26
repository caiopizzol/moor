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
    -- Text timestamps are second-precision (SQLite datetime). Kept for human-
    -- readable display; duration_ms computation prefers the _ms columns below
    -- which are written from Date.now() in JS at insert/finalize time. See #45.
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    started_at_ms INTEGER,
    finished_at_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_exec_runs_project_started
    ON exec_runs(project_id, started_at);

  -- #35: per-project named Docker volume mounts. docker_name is the actual
  -- Docker volume name, stored at config-creation time. We do NOT derive it
  -- from project.name on every start — projects can be renamed, and deriving
  -- later would silently mount a fresh empty volume next to the original
  -- (which still holds the data under the old derived name). target is the
  -- in-container mount path. UNIQUE(project_id, name) makes the per-project
  -- logical handle unique; UNIQUE(project_id, target) prevents two volumes
  -- competing for the same mount point; UNIQUE(docker_name) prevents
  -- accidental cross-project clashes (the prefix already gives separation,
  -- this guards against pathological project-name collisions).
  CREATE TABLE IF NOT EXISTS project_volumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    docker_name TEXT NOT NULL UNIQUE,
    UNIQUE(project_id, name),
    UNIQUE(project_id, target)
  );

  CREATE INDEX IF NOT EXISTS idx_project_volumes_project ON project_volumes(project_id);

  -- #54: per-execute audit of guarded cleanup runs. candidates_json captures
  -- the exact list the caller passed (after server-side validation of shape);
  -- results_json captures the post-revalidation outcome for each one. Keeping
  -- them as separate JSON blobs preserves the asymmetry between what was
  -- requested and what actually happened — important because Docker state can
  -- change between plan and execute, and some candidates legitimately turn
  -- into no-ops at execute time.
  CREATE TABLE IF NOT EXISTS cleanup_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executed_at TEXT NOT NULL DEFAULT (datetime('now')),
    candidates_json TEXT NOT NULL,
    results_json TEXT NOT NULL,
    reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
    error_text TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cleanup_audit_executed_at
    ON cleanup_audit(executed_at);

  -- #79: singleton drain-mode flag. CHECK(id=1) enforces one row.
  -- expires_at is the TTL auto-clear timestamp; drain.ts treats a past
  -- expires_at as not-drained and lazily clears the row on read.
  -- clear_after_version is the optional updater hook: if set and the
  -- running moor version matches it on boot, the row clears (the
  -- upgrade actually happened, so drain has served its purpose).
  CREATE TABLE IF NOT EXISTS drain_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    started_at TEXT,
    expires_at TEXT,
    clear_after_version TEXT
  );

  -- #80 PR #1: audit trail for moor's self-update flow.
  -- Row is INSERTed before the backup runs so a backup failure is captured;
  -- backup_path is therefore nullable. State transitions:
  --   in_progress → success | rolled_back | rollback_failed | failed | crashed
  -- 'crashed' is only set by the 30-min grace-window sweep — it means a
  -- respawner-issued marker was never ingested. Operator should investigate.
  -- from_digest / to_digest / prev_image_id pin the image identities at apply
  -- time so a rollback path knows exactly where to revert to.
  CREATE TABLE IF NOT EXISTS update_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at_ms INTEGER NOT NULL,
    finished_at TEXT,
    finished_at_ms INTEGER,
    duration_ms INTEGER,
    state TEXT NOT NULL DEFAULT 'in_progress',
    from_digest TEXT,
    to_digest TEXT,
    prev_image_id TEXT,
    backup_path TEXT,
    rollback_error TEXT,
    error_log TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_update_audit_started_at_ms
    ON update_audit(started_at_ms DESC);

  CREATE INDEX IF NOT EXISTS idx_update_audit_state
    ON update_audit(state);

  -- Per-registry credentials for private image pulls. One row per registry
  -- hostname. The pull path looks up by hostname extracted from the image
  -- ref; a match produces an X-Registry-Auth header on /images/create. No
  -- match means anonymous pull, preserving today's public-image behavior.
  -- Stored plaintext, consistent with env_vars: the DB file is the trust
  -- boundary. API reads NEVER return the secret -- they return metadata
  -- plus a kind derived at read time from the secret's known prefixes.
  CREATE TABLE IF NOT EXISTS registry_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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

// #45: millisecond timestamps for exec_runs. New rows write Date.now() from
// JS in exec-async.ts. Old rows are backfilled best-effort from the text
// columns, which are SQLite second-precision so the backfilled values are
// snapped to the start of their wall-clock second (good enough for runs that
// pre-date this migration). New rows get true millisecond precision.
try {
  db.exec("ALTER TABLE exec_runs ADD COLUMN started_at_ms INTEGER");
  db.exec(
    "UPDATE exec_runs SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 WHERE started_at_ms IS NULL AND started_at IS NOT NULL",
  );
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE exec_runs ADD COLUMN finished_at_ms INTEGER");
  db.exec(
    "UPDATE exec_runs SET finished_at_ms = CAST(strftime('%s', finished_at) AS INTEGER) * 1000 WHERE finished_at_ms IS NULL AND finished_at IS NOT NULL",
  );
} catch {
  // Column already exists
}

// #36: per-project memory and CPU limits. NULL = unbounded (current behavior,
// no Docker HostConfig fields set). When set: memory_limit_mb maps to Memory
// (and equal MemorySwap so the container can't burn through host swap) and
// cpus maps to NanoCpus (cpus * 1e9). Limits take effect on container
// recreate — handleStart/handleRun all call createAndStartContainer which
// force-removes the existing container by name and creates fresh.
try {
  db.exec("ALTER TABLE projects ADD COLUMN memory_limit_mb INTEGER");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN cpus REAL");
} catch {
  // Column already exists
}

// #71: dual-field model for runtime truth. projects.status stays moor's
// *recorded* state (changes only on explicit moor actions: start/stop/
// build/cancel). The live_* fields are written by the status reconciler
// background loop and reflect Docker's view at last successful inspect.
// Both directions matter — DB can drift from Docker (missed exit) and
// Docker can drift from DB (recorded as error but container still up).
// live_error is non-null only when the most recent inspect failed
// (socket unreachable, 5xx, parse failure); the loop preserves the last
// successful live_status / live_exit_code in that case so a transient
// daemon glitch doesn't rewrite truth.
try {
  db.exec("ALTER TABLE projects ADD COLUMN live_status TEXT");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN live_exit_code INTEGER");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN live_checked_at TEXT");
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE projects ADD COLUMN live_error TEXT");
} catch {
  // Column already exists
}

// #65: live build observability. runs now represents the full deploy run
// (build/pull + container start) and is INSERTed at start with finished_at
// NULL, then UPDATEd as output streams in. Status uses the existing
// finished_at IS NULL convention (no new state column — that would force
// a coordinated web/MCP rollout). The new *_total_bytes columns capture
// the truth Docker emitted, since stdout/stderr now store at most a
// 64 KiB tail (TAIL_CAP_BYTES) for builds. Backfill: existing rows store
// full output, so total_bytes == length(stored).
try {
  db.exec("ALTER TABLE runs ADD COLUMN started_at_ms INTEGER");
  db.exec(
    "UPDATE runs SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 WHERE started_at_ms IS NULL AND started_at IS NOT NULL",
  );
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE runs ADD COLUMN finished_at_ms INTEGER");
  db.exec(
    "UPDATE runs SET finished_at_ms = CAST(strftime('%s', finished_at) AS INTEGER) * 1000 WHERE finished_at_ms IS NULL AND finished_at IS NOT NULL",
  );
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE runs ADD COLUMN stdout_total_bytes INTEGER");
  db.exec(
    "UPDATE runs SET stdout_total_bytes = length(CAST(stdout AS BLOB)) WHERE stdout_total_bytes IS NULL AND stdout IS NOT NULL",
  );
} catch {
  // Column already exists
}

try {
  db.exec("ALTER TABLE runs ADD COLUMN stderr_total_bytes INTEGER");
  db.exec(
    "UPDATE runs SET stderr_total_bytes = length(CAST(stderr AS BLOB)) WHERE stderr_total_bytes IS NULL AND stderr IS NOT NULL",
  );
} catch {
  // Column already exists
}

// #65 orphan sweep for build/manual runs. cron_id IS NULL && finished_at
// IS NULL means a build was in flight when moor crashed/restarted — the
// in-memory tail buffer and SSE consumer are gone, so the row has no path
// back to a terminal state. Mark it failed with an honest stderr note,
// matching the #34 Phase B pattern for exec_runs. Cron runs follow a
// different lifecycle (cron.ts owns its own sweep) and are excluded by
// the cron_id IS NOT NULL guard.
//
// Force exit_code = 1 rather than COALESCE: an interrupted row has
// terminal-unknown outcome, and preserving any earlier value would be
// dishonest. The appended stderr note has to also bump
// stderr_total_bytes — moor_runs reports bytes from total, and
// reporting "0 B" while we just wrote a note would mislead.
db.exec(`
  UPDATE runs
  SET finished_at = datetime('now'),
      finished_at_ms = CAST((strftime('%s', 'now') * 1000) AS INTEGER),
      exit_code = 1,
      stderr = COALESCE(stderr, '') ||
               CASE WHEN stderr IS NULL OR stderr = '' THEN '' ELSE char(10) END ||
               '[moor restarted; terminal state unknown]',
      stderr_total_bytes = COALESCE(stderr_total_bytes, 0) +
        length(CAST(
          CASE WHEN stderr IS NULL OR stderr = ''
               THEN '[moor restarted; terminal state unknown]'
               ELSE char(10) || '[moor restarted; terminal state unknown]'
          END
        AS BLOB))
  WHERE finished_at IS NULL AND cron_id IS NULL
`);

export default db;
