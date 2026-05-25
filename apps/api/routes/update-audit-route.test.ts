// Tests for #80 PR #6 GET /api/server/update/audit. In-memory SQLite,
// no Docker. Seeds audit rows via insertAuditInProgress + finalizeAudit
// and asserts the route returns them in the documented shape.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { finalizeAudit, insertAuditInProgress } = await import("../update-audit");
const { handleServer } = await import("./server");

async function call(method: string, path: string): Promise<Response> {
  const req = new Request(`http://localhost${path}`, { method });
  const res = await handleServer(req, new URL(req.url));
  if (!res) throw new Error(`handleServer returned null for ${method} ${path}`);
  return res;
}

function reset() {
  db.query("DELETE FROM update_audit").run();
}

describe("#80 PR #6 GET /api/server/update/audit", () => {
  beforeEach(reset);

  test("empty → 200 with rows:[]", async () => {
    const res = await call("GET", "/api/server/update/audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  test("returns rows newest first with full schema", async () => {
    const a = insertAuditInProgress({
      from_digest: `sha256:${"a".repeat(64)}`,
      to_digest: `sha256:${"b".repeat(64)}`,
      prev_image_id: `sha256:${"a".repeat(64)}`,
    });
    finalizeAudit(a, "success");
    const b = insertAuditInProgress({
      from_digest: `sha256:${"b".repeat(64)}`,
      to_digest: `sha256:${"c".repeat(64)}`,
      prev_image_id: `sha256:${"b".repeat(64)}`,
    });
    finalizeAudit(b, "rolled_back", { error_log: "health failed" });

    const res = await call("GET", "/api/server/update/audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: number;
        state: string;
        from_digest: string;
        to_digest: string;
        error_log: string | null;
        rollback_error: string | null;
        backup_path: string | null;
      }>;
    };
    expect(body.rows.length).toBe(2);
    expect(body.rows[0].id).toBe(b);
    expect(body.rows[0].state).toBe("rolled_back");
    expect(body.rows[0].error_log).toBe("health failed");
    expect(body.rows[0].rollback_error).toBeNull();
    expect(body.rows[1].id).toBe(a);
    expect(body.rows[1].state).toBe("success");
  });

  test("limit query param caps the response", async () => {
    for (let i = 0; i < 5; i++) {
      const id = insertAuditInProgress({ from_digest: null, to_digest: null, prev_image_id: null });
      finalizeAudit(id, "success");
    }
    const res = await call("GET", "/api/server/update/audit?limit=3");
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows.length).toBe(3);
  });

  test("limit out of range → 400", async () => {
    for (const bad of ["0", "201", "abc", "-1", "1.5"]) {
      const res = await call("GET", `/api/server/update/audit?limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });
});
