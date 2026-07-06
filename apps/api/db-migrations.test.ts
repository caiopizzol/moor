import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { finalSchemaVersion, type Migration, runMigrations } from "./db-migrations";

const BASELINE_SCHEMA_SQL = `
  CREATE TABLE projects (
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

  CREATE TABLE crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    command TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE runs (
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

  CREATE TABLE exec_runs (
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
    finished_at TEXT,
    started_at_ms INTEGER,
    finished_at_ms INTEGER
  );

  CREATE TABLE source_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL,
    label TEXT NOT NULL,
    username TEXT NOT NULL,
    secret TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'failed')),
    expires_at TEXT,
    last_checked_at TEXT,
    last_check_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(hostname, label)
  );
`;

type MigrationTable = "projects" | "runs" | "exec_runs";

function withBaselineDatabase(run: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(BASELINE_SCHEMA_SQL);
    run(db);
  } finally {
    db.close();
  }
}

function withEmptyDatabase(run: (db: Database) => void): void {
  const db = new Database(":memory:");
  try {
    run(db);
  } finally {
    db.close();
  }
}

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function columnNames(db: Database, table: MigrationTable): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function expectColumns(db: Database, table: MigrationTable, columns: readonly string[]): void {
  const names = columnNames(db, table);
  for (const column of columns) {
    expect(names.has(column)).toBe(true);
  }
}

function addLegacyMigrationColumns(db: Database): void {
  db.exec(`
    ALTER TABLE projects ADD COLUMN docker_image TEXT;
    ALTER TABLE projects ADD COLUMN domain TEXT;
    ALTER TABLE projects ADD COLUMN domain_port INTEGER;
    ALTER TABLE projects ADD COLUMN restart_policy TEXT DEFAULT 'unless-stopped';
    ALTER TABLE projects ADD COLUMN memory_limit_mb INTEGER;
    ALTER TABLE projects ADD COLUMN cpus REAL;
    ALTER TABLE projects ADD COLUMN live_status TEXT;
    ALTER TABLE projects ADD COLUMN live_exit_code INTEGER;
    ALTER TABLE projects ADD COLUMN live_checked_at TEXT;
    ALTER TABLE projects ADD COLUMN live_error TEXT;
    ALTER TABLE runs ADD COLUMN started_at_ms INTEGER;
    ALTER TABLE runs ADD COLUMN finished_at_ms INTEGER;
    ALTER TABLE runs ADD COLUMN stdout_total_bytes INTEGER;
    ALTER TABLE runs ADD COLUMN stderr_total_bytes INTEGER;
    ALTER TABLE projects ADD COLUMN source_credential_id INTEGER REFERENCES source_credentials(id);
    ALTER TABLE projects ADD COLUMN command TEXT;
    ALTER TABLE projects ADD COLUMN entrypoint TEXT;
  `);
}

describe("schema migrations", () => {
  test("fresh in-memory baseline reaches the final schema", () => {
    withBaselineDatabase((db) => {
      expect(userVersion(db)).toBe(0);

      runMigrations(db);

      expect(userVersion(db)).toBe(finalSchemaVersion);
      expectColumns(db, "projects", [
        "docker_image",
        "domain",
        "domain_port",
        "restart_policy",
        "memory_limit_mb",
        "cpus",
        "live_status",
        "live_exit_code",
        "live_checked_at",
        "live_error",
        "source_credential_id",
        "command",
        "entrypoint",
      ]);
      expectColumns(db, "runs", [
        "started_at_ms",
        "finished_at_ms",
        "stdout_total_bytes",
        "stderr_total_bytes",
      ]);
      expectColumns(db, "exec_runs", ["started_at_ms", "finished_at_ms"]);
    });
  });

  test("pre-versioning database with existing columns records migration versions", () => {
    withBaselineDatabase((db) => {
      addLegacyMigrationColumns(db);
      const project = db
        .query("INSERT INTO projects (name) VALUES ('legacy') RETURNING id")
        .get() as {
        id: number;
      };
      db.query(
        `INSERT INTO exec_runs
         (project_id, command, timeout_ms, started_at, finished_at, started_at_ms, finished_at_ms)
         VALUES (?, 'legacy-exec', 60000, '2025-01-01 12:34:56', '2025-01-01 12:35:00', NULL, NULL)`,
      ).run(project.id);
      db.query(
        `INSERT INTO runs
         (project_id, started_at, finished_at, stdout, stderr,
          started_at_ms, finished_at_ms, stdout_total_bytes, stderr_total_bytes)
         VALUES (?, '2025-01-02 01:02:03', '2025-01-02 01:02:04', 'hello', 'warn',
                 NULL, NULL, NULL, NULL)`,
      ).run(project.id);

      runMigrations(db);

      expect(userVersion(db)).toBe(finalSchemaVersion);
      const execRun = db
        .query("SELECT started_at_ms, finished_at_ms FROM exec_runs WHERE command = 'legacy-exec'")
        .get() as { started_at_ms: number; finished_at_ms: number };
      expect(execRun.started_at_ms).toBe(Date.UTC(2025, 0, 1, 12, 34, 56));
      expect(execRun.finished_at_ms).toBe(Date.UTC(2025, 0, 1, 12, 35, 0));

      const run = db
        .query(
          "SELECT started_at_ms, finished_at_ms, stdout_total_bytes, stderr_total_bytes FROM runs",
        )
        .get() as {
        started_at_ms: number;
        finished_at_ms: number;
        stdout_total_bytes: number;
        stderr_total_bytes: number;
      };
      expect(run.started_at_ms).toBe(Date.UTC(2025, 0, 2, 1, 2, 3));
      expect(run.finished_at_ms).toBe(Date.UTC(2025, 0, 2, 1, 2, 4));
      expect(run.stdout_total_bytes).toBe("hello".length);
      expect(run.stderr_total_bytes).toBe("warn".length);
    });
  });

  test("failing migration throws and rolls back its version", () => {
    withEmptyDatabase((db) => {
      const failingMigration: Migration = {
        version: 1,
        up(database) {
          database.exec("CREATE TABLE partial_migration (id INTEGER PRIMARY KEY)");
          database.exec("SELECT * FROM missing_table");
        },
      };

      expect(() => runMigrations(db, [failingMigration])).toThrow();
      expect(userVersion(db)).toBe(0);
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_migration'",
          )
          .get(),
      ).toBeNull();
    });
  });
});
