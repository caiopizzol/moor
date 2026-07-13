import type { Database } from "bun:sqlite";

export type Migration = {
  version: number;
  up: (db: Database) => void;
};

type TableInfoRow = {
  name: string;
};

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableInfoRow[];
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, sql: string): void {
  if (hasColumn(db, table, column)) {
    return;
  }

  db.exec(sql);
}

function getUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

function setUserVersion(db: Database, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

export const schemaMigrations: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "docker_image",
        "ALTER TABLE projects ADD COLUMN docker_image TEXT",
      );
    },
  },
  {
    version: 2,
    up(db) {
      addColumnIfMissing(db, "projects", "domain", "ALTER TABLE projects ADD COLUMN domain TEXT");
    },
  },
  {
    version: 3,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "domain_port",
        "ALTER TABLE projects ADD COLUMN domain_port INTEGER",
      );
    },
  },
  {
    version: 4,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "restart_policy",
        "ALTER TABLE projects ADD COLUMN restart_policy TEXT DEFAULT 'unless-stopped'",
      );
    },
  },

  // #45: millisecond timestamps for exec_runs. New rows write Date.now() from
  // JS in exec-async.ts. Old rows are backfilled best-effort from the text
  // columns, which are SQLite second-precision so the backfilled values are
  // snapped to the start of their wall-clock second (good enough for runs that
  // pre-date this migration). New rows get true millisecond precision.
  {
    version: 5,
    up(db) {
      addColumnIfMissing(
        db,
        "exec_runs",
        "started_at_ms",
        "ALTER TABLE exec_runs ADD COLUMN started_at_ms INTEGER",
      );
      db.exec(
        "UPDATE exec_runs SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 WHERE started_at_ms IS NULL AND started_at IS NOT NULL",
      );
    },
  },
  {
    version: 6,
    up(db) {
      addColumnIfMissing(
        db,
        "exec_runs",
        "finished_at_ms",
        "ALTER TABLE exec_runs ADD COLUMN finished_at_ms INTEGER",
      );
      db.exec(
        "UPDATE exec_runs SET finished_at_ms = CAST(strftime('%s', finished_at) AS INTEGER) * 1000 WHERE finished_at_ms IS NULL AND finished_at IS NOT NULL",
      );
    },
  },

  // #36: per-project memory and CPU limits. NULL = unbounded (current behavior,
  // no Docker HostConfig fields set). When set: memory_limit_mb maps to Memory
  // (and equal MemorySwap so the container can't burn through host swap) and
  // cpus maps to NanoCpus (cpus * 1e9). Limits take effect on container
  // recreate — handleStart/handleRun all call createAndStartContainer which
  // force-removes the existing container by name and creates fresh.
  {
    version: 7,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "memory_limit_mb",
        "ALTER TABLE projects ADD COLUMN memory_limit_mb INTEGER",
      );
    },
  },
  {
    version: 8,
    up(db) {
      addColumnIfMissing(db, "projects", "cpus", "ALTER TABLE projects ADD COLUMN cpus REAL");
    },
  },

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
  {
    version: 9,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "live_status",
        "ALTER TABLE projects ADD COLUMN live_status TEXT",
      );
    },
  },
  {
    version: 10,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "live_exit_code",
        "ALTER TABLE projects ADD COLUMN live_exit_code INTEGER",
      );
    },
  },
  {
    version: 11,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "live_checked_at",
        "ALTER TABLE projects ADD COLUMN live_checked_at TEXT",
      );
    },
  },
  {
    version: 12,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "live_error",
        "ALTER TABLE projects ADD COLUMN live_error TEXT",
      );
    },
  },

  // #65: live build observability. runs now represents the full deploy run
  // (build/pull + container start) and is INSERTed at start with finished_at
  // NULL, then UPDATEd as output streams in. Status uses the existing
  // finished_at IS NULL convention (no new state column — that would force
  // a coordinated web/MCP rollout). The new *_total_bytes columns capture
  // the truth Docker emitted, since stdout/stderr now store at most a
  // 64 KiB tail (TAIL_CAP_BYTES) for builds. Backfill: existing rows store
  // full output, so total_bytes == length(stored).
  {
    version: 13,
    up(db) {
      addColumnIfMissing(
        db,
        "runs",
        "started_at_ms",
        "ALTER TABLE runs ADD COLUMN started_at_ms INTEGER",
      );
      db.exec(
        "UPDATE runs SET started_at_ms = CAST(strftime('%s', started_at) AS INTEGER) * 1000 WHERE started_at_ms IS NULL AND started_at IS NOT NULL",
      );
    },
  },
  {
    version: 14,
    up(db) {
      addColumnIfMissing(
        db,
        "runs",
        "finished_at_ms",
        "ALTER TABLE runs ADD COLUMN finished_at_ms INTEGER",
      );
      db.exec(
        "UPDATE runs SET finished_at_ms = CAST(strftime('%s', finished_at) AS INTEGER) * 1000 WHERE finished_at_ms IS NULL AND finished_at IS NOT NULL",
      );
    },
  },
  {
    version: 15,
    up(db) {
      addColumnIfMissing(
        db,
        "runs",
        "stdout_total_bytes",
        "ALTER TABLE runs ADD COLUMN stdout_total_bytes INTEGER",
      );
      db.exec(
        "UPDATE runs SET stdout_total_bytes = length(CAST(stdout AS BLOB)) WHERE stdout_total_bytes IS NULL AND stdout IS NOT NULL",
      );
    },
  },
  {
    version: 16,
    up(db) {
      addColumnIfMissing(
        db,
        "runs",
        "stderr_total_bytes",
        "ALTER TABLE runs ADD COLUMN stderr_total_bytes INTEGER",
      );
      db.exec(
        "UPDATE runs SET stderr_total_bytes = length(CAST(stderr AS BLOB)) WHERE stderr_total_bytes IS NULL AND stderr IS NOT NULL",
      );
    },
  },

  // #111: projects opt into a stored source credential. NULL = today's path
  // (anonymous public clone, or legacy URL-embedded credentials in
  // github_url). When set, the build path resolves the credential and
  // uses it for Docker's daemon-side `remote=` build (#112 wires the
  // in-memory URL synthesis). FK uses ON DELETE RESTRICT semantics via
  // the route layer (deleteCredential refuses when projects reference
  // it); SQLite's RESTRICT is the default for REFERENCES.
  {
    version: 17,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "source_credential_id",
        "ALTER TABLE projects ADD COLUMN source_credential_id INTEGER REFERENCES source_credentials(id)",
      );
    },
  },

  // Declarative container command/entrypoint override. NULL = today's behavior
  // (run the image's own default CMD/ENTRYPOINT). When set, stored as a JSON
  // string array and threaded into the Docker create body as Cmd / Entrypoint on
  // the next container recreate. Lets a stock image (e.g. cloudflare/cloudflared)
  // run a custom command without a throwaway Dockerfile.
  {
    version: 18,
    up(db) {
      addColumnIfMissing(db, "projects", "command", "ALTER TABLE projects ADD COLUMN command TEXT");
    },
  },
  {
    version: 19,
    up(db) {
      addColumnIfMissing(
        db,
        "projects",
        "entrypoint",
        "ALTER TABLE projects ADD COLUMN entrypoint TEXT",
      );
    },
  },
  {
    version: 20,
    up(db) {
      addColumnIfMissing(
        db,
        "crons",
        "timeout_ms",
        "ALTER TABLE crons ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 600000",
      );
    },
  },
];

export const finalSchemaVersion = schemaMigrations[schemaMigrations.length - 1]?.version ?? 0;

export function runMigrations(
  db: Database,
  migrations: readonly Migration[] = schemaMigrations,
): void {
  let currentVersion = getUserVersion(db);
  let previousMigrationVersion = 0;
  const runMigration = db.transaction((migration: Migration) => {
    migration.up(db);
    setUserVersion(db, migration.version);
  });

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (migration.version <= previousMigrationVersion) {
      throw new Error(
        `Migrations must be ordered by increasing version: ${migration.version} after ${previousMigrationVersion}`,
      );
    }
    previousMigrationVersion = migration.version;

    if (migration.version <= currentVersion) {
      continue;
    }

    runMigration(migration);
    currentVersion = migration.version;
  }
}
