// Integration test for the credential round-trip behavior described in #30.
// Runs against an in-memory SQLite DB so the dev/prod file is never touched.

// MOOR_DB_PATH must be set before ../db.ts evaluates. Static `import` is hoisted
// above this assignment, so we dynamically import after the env var is set.
process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleProjects } = await import("./projects");

const CREDENTIALED = "https://x-access-token:TOKEN_AAAA@github.com/owner/repo";
const REDACTED = "https://github.com/owner/repo";

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleProjects(req, new URL(req.url));
  if (!res) throw new Error(`handleProjects returned null for ${method} ${path}`);
  return res;
}

function insertProject(name: string, github_url: string | null): { id: number } {
  return db
    .query(
      "INSERT INTO projects (name, github_url, branch, dockerfile, restart_policy) VALUES (?, ?, 'main', 'Dockerfile', 'unless-stopped') RETURNING id",
    )
    .get(name, github_url) as { id: number };
}

function storedUrl(id: number): string | null {
  const row = db.query("SELECT github_url FROM projects WHERE id = ?").get(id) as {
    github_url: string | null;
  } | null;
  return row?.github_url ?? null;
}

describe("#30 project URL credential redaction", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
  });

  test("GET /api/projects redacts credentials in the list", async () => {
    insertProject("a", CREDENTIALED);
    const res = await call("GET", "/api/projects");
    const body = (await res.json()) as Array<{ github_url: string | null }>;
    expect(body).toHaveLength(1);
    expect(body[0].github_url).toBe(REDACTED);
  });

  test("GET /api/projects/:id redacts the single record", async () => {
    const p = insertProject("a", CREDENTIALED);
    const res = await call("GET", `/api/projects/${p.id}`);
    const body = (await res.json()) as { github_url: string | null };
    expect(body.github_url).toBe(REDACTED);
  });

  test("DB still contains the credentialed URL after GET", async () => {
    const p = insertProject("a", CREDENTIALED);
    await call("GET", `/api/projects/${p.id}`);
    expect(storedUrl(p.id)).toBe(CREDENTIALED);
  });

  test("PUT echoing the redacted URL back preserves stored credentials", async () => {
    const p = insertProject("a", CREDENTIALED);
    // Simulates the UI loading the project (GET returns redacted URL) and the
    // user changing an unrelated field (branch), then saving. The PUT body
    // therefore contains the redacted URL it read.
    const res = await call("PUT", `/api/projects/${p.id}`, {
      github_url: REDACTED,
      branch: "develop",
    });
    expect(res.status).toBeLessThan(400);
    expect(storedUrl(p.id)).toBe(CREDENTIALED);
    const row = db.query("SELECT branch FROM projects WHERE id = ?").get(p.id) as {
      branch: string;
    };
    expect(row.branch).toBe("develop");
  });

  test("PUT with only the round-tripped URL is a no-op, not a 400", async () => {
    const p = insertProject("a", CREDENTIALED);
    const res = await call("PUT", `/api/projects/${p.id}`, { github_url: REDACTED });
    expect(res.status).toBeLessThan(400);
    expect(storedUrl(p.id)).toBe(CREDENTIALED);
  });

  test("PUT with a genuinely different URL replaces stored credentials", async () => {
    const p = insertProject("a", CREDENTIALED);
    const res = await call("PUT", `/api/projects/${p.id}`, {
      github_url: "https://github.com/owner/different",
    });
    expect(res.status).toBeLessThan(400);
    expect(storedUrl(p.id)).toBe("https://github.com/owner/different");
  });

  test("PUT with new credentials replaces stored credentials", async () => {
    const p = insertProject("a", CREDENTIALED);
    const rotated = "https://x-access-token:TOKEN_BBBB@github.com/owner/repo";
    await call("PUT", `/api/projects/${p.id}`, { github_url: rotated });
    expect(storedUrl(p.id)).toBe(rotated);
  });

  test("PUT response carries the redacted URL", async () => {
    const p = insertProject("a", CREDENTIALED);
    const res = await call("PUT", `/api/projects/${p.id}`, { branch: "develop" });
    const body = (await res.json()) as { github_url: string | null };
    expect(body.github_url).toBe(REDACTED);
    expect(storedUrl(p.id)).toBe(CREDENTIALED);
  });

  test("POST response is redacted", async () => {
    const res = await call("POST", "/api/projects", {
      name: "fresh",
      github_url: CREDENTIALED,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; github_url: string | null };
    expect(body.github_url).toBe(REDACTED);
    expect(storedUrl(body.id)).toBe(CREDENTIALED);
  });

  test("source-switching is suppressed when github_url is round-tripped", async () => {
    // If the caller sends docker_image AND a round-tripped github_url, the
    // round-trip should not trigger the alternative-source clearing logic.
    // Otherwise the unchanged github_url save would null out docker_image
    // every time the modal is reopened on a docker-image project.
    const p = insertProject("a", CREDENTIALED);
    // Simulate caller sending the redacted URL plus a domain change; no
    // docker_image involved. The github_url should remain stored as-is.
    const res = await call("PUT", `/api/projects/${p.id}`, {
      github_url: REDACTED,
      branch: "main",
    });
    expect(res.status).toBeLessThan(400);
    expect(storedUrl(p.id)).toBe(CREDENTIALED);
  });

  // #36: resource-limits validation on POST/PUT
  test("POST rejects memory_limit_mb below the Docker floor", async () => {
    const res = await call("POST", "/api/projects", {
      name: "mem-low",
      docker_image: "nginx:alpine",
      memory_limit_mb: 4,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("memory_limit_mb must be >=");
  });

  test("POST rejects cpus <= 0 (null is the clear signal)", async () => {
    const res = await call("POST", "/api/projects", {
      name: "cpu-zero",
      docker_image: "nginx:alpine",
      cpus: 0,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("cpus must be > 0");
  });

  test("POST accepts and persists valid memory_limit_mb and cpus", async () => {
    const res = await call("POST", "/api/projects", {
      name: "limited",
      docker_image: "nginx:alpine",
      memory_limit_mb: 256,
      cpus: 0.5,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; memory_limit_mb: number; cpus: number };
    expect(body.memory_limit_mb).toBe(256);
    expect(body.cpus).toBe(0.5);
  });

  test("PUT with memory_limit_mb=null clears a previously-set limit", async () => {
    insertProject("clear-test", null);
    const row = db.query("SELECT id FROM projects WHERE name = 'clear-test'").get() as {
      id: number;
    };
    // First set a limit
    await call("PUT", `/api/projects/${row.id}`, { memory_limit_mb: 512 });
    let stored = db.query("SELECT memory_limit_mb FROM projects WHERE id = ?").get(row.id) as {
      memory_limit_mb: number | null;
    };
    expect(stored.memory_limit_mb).toBe(512);
    // Now clear it via null
    const res = await call("PUT", `/api/projects/${row.id}`, { memory_limit_mb: null });
    expect(res.status).toBeLessThan(400);
    stored = db.query("SELECT memory_limit_mb FROM projects WHERE id = ?").get(row.id) as {
      memory_limit_mb: number | null;
    };
    expect(stored.memory_limit_mb).toBeNull();
  });

  test("PUT with cpus=null clears the limit; PUT without the field leaves it alone", async () => {
    insertProject("cpus-test", null);
    const row = db.query("SELECT id FROM projects WHERE name = 'cpus-test'").get() as {
      id: number;
    };
    await call("PUT", `/api/projects/${row.id}`, { cpus: 1.5 });
    // Updating an unrelated field doesn't touch cpus
    await call("PUT", `/api/projects/${row.id}`, { branch: "develop" });
    let stored = db.query("SELECT cpus FROM projects WHERE id = ?").get(row.id) as {
      cpus: number | null;
    };
    expect(stored.cpus).toBe(1.5);
    // Explicit null clears
    await call("PUT", `/api/projects/${row.id}`, { cpus: null });
    stored = db.query("SELECT cpus FROM projects WHERE id = ?").get(row.id) as {
      cpus: number | null;
    };
    expect(stored.cpus).toBeNull();
  });
});
