// Integration tests for /api/server/registry-credentials. In-memory
// SQLite; no Docker. Covers happy CRUD paths, write-only read shape,
// duplicate hostname conflict, malformed JSON, type validation, and
// URL/image-ref-shaped hostname rejection.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../db");
const { handleRegistryCredentials } = await import("./registry-credentials");

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await handleRegistryCredentials(req, new URL(req.url));
  if (!res) throw new Error(`handler returned null for ${method} ${path}`);
  return res;
}

describe("/api/server/registry-credentials", () => {
  beforeEach(() => {
    db.query("DELETE FROM registry_credentials").run();
  });

  describe("POST (create)", () => {
    test("happy path returns 201 with metadata and no raw secret", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_classic",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: number;
        hostname: string;
        username: string;
        secret: { configured: true; kind: string };
      };
      expect(body.hostname).toBe("ghcr.io");
      expect(body.username).toBe("alice");
      expect(body.secret).toEqual({ configured: true, kind: "github_classic_pat" });
      // Raw secret material never crosses the API boundary.
      expect(JSON.stringify(body).includes("ghp_classic")).toBe(false);
    });

    test("normalizes hostname casing", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "GHCR.IO",
        username: "alice",
        secret: "ghp_x",
      });
      const body = (await res.json()) as { hostname: string };
      expect(body.hostname).toBe("ghcr.io");
    });

    test("duplicate hostname → 409", async () => {
      await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_one",
      });
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "bob",
        secret: "ghp_two",
      });
      expect(res.status).toBe(409);
    });

    test("duplicate hostname differing only in case → 409 (normalization applies)", async () => {
      await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_one",
      });
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "GHCR.IO",
        username: "bob",
        secret: "ghp_two",
      });
      expect(res.status).toBe(409);
    });

    test("malformed JSON → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", "{not json");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/invalid JSON/i);
    });

    test("array body → 400 (must be object)", async () => {
      const res = await call("POST", "/api/server/registry-credentials", [
        { hostname: "ghcr.io", username: "a", secret: "ghp_x" },
      ]);
      expect(res.status).toBe(400);
    });

    test("null body → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", null);
      expect(res.status).toBe(400);
    });

    test("non-string hostname (number) → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: 42,
        username: "alice",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/hostname must be a string/);
    });

    test("non-string secret (null) → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: null,
      });
      expect(res.status).toBe(400);
    });

    test("empty hostname → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "",
        username: "alice",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
    });

    test("whitespace-only username → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "   ",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
    });

    test("URL-shaped hostname (https://...) → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "https://ghcr.io",
        username: "alice",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/hostname/);
    });

    test("image-ref-shaped hostname (ghcr.io/owner/img) → 400", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io/owner/img",
        username: "alice",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
    });

    test("port-bearing hostname (localhost:5000) is accepted", async () => {
      const res = await call("POST", "/api/server/registry-credentials", {
        hostname: "localhost:5000",
        username: "alice",
        secret: "ghp_x",
      });
      expect(res.status).toBe(201);
    });
  });

  describe("GET (list and by id)", () => {
    test("empty list returns 200 with rows:[]", async () => {
      const res = await call("GET", "/api/server/registry-credentials");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[] };
      expect(body.rows).toEqual([]);
    });

    test("list returns metadata only, no raw secret", async () => {
      await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_classic",
      });
      const res = await call("GET", "/api/server/registry-credentials");
      const body = (await res.json()) as {
        rows: Array<{ hostname: string; secret: unknown }>;
      };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].secret).toEqual({ configured: true, kind: "github_classic_pat" });
      expect(JSON.stringify(body).includes("ghp_classic")).toBe(false);
    });

    test("get by id returns metadata", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_classic",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("GET", `/api/server/registry-credentials/${id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hostname: string };
      expect(body.hostname).toBe("ghcr.io");
    });

    test("get by id for missing → 404", async () => {
      const res = await call("GET", "/api/server/registry-credentials/99999");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT (update)", () => {
    test("rotates secret, kind reflects new prefix", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_old",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("PUT", `/api/server/registry-credentials/${id}`, {
        secret: "github_pat_11NEW",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { secret: { kind: string } };
      expect(body.secret.kind).toBe("github_fine_grained_pat");
    });

    test("can patch username only", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_x",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("PUT", `/api/server/registry-credentials/${id}`, {
        username: "bob",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { username: string };
      expect(body.username).toBe("bob");
    });

    test("rejects hostname in patch (must delete and recreate)", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_x",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("PUT", `/api/server/registry-credentials/${id}`, {
        hostname: "docker.io",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/hostname is not patchable/);
    });

    test("update with empty secret → 400", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_x",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("PUT", `/api/server/registry-credentials/${id}`, { secret: "" });
      expect(res.status).toBe(400);
    });

    test("update missing id → 404", async () => {
      const res = await call("PUT", "/api/server/registry-credentials/99999", {
        secret: "ghp_x",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE", () => {
    test("delete existing → 204", async () => {
      const created = await call("POST", "/api/server/registry-credentials", {
        hostname: "ghcr.io",
        username: "alice",
        secret: "ghp_x",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("DELETE", `/api/server/registry-credentials/${id}`);
      expect(res.status).toBe(204);
      const after = await call("GET", `/api/server/registry-credentials/${id}`);
      expect(after.status).toBe(404);
    });

    test("delete missing → 404", async () => {
      const res = await call("DELETE", "/api/server/registry-credentials/99999");
      expect(res.status).toBe(404);
    });
  });

  describe("dispatcher", () => {
    test("returns null (passes through) for unrelated paths", async () => {
      const req = new Request("http://localhost/api/projects", { method: "GET" });
      const res = await handleRegistryCredentials(req, new URL(req.url));
      expect(res).toBeNull();
    });

    test("unknown method on collection → 405", async () => {
      const res = await call("PATCH", "/api/server/registry-credentials");
      expect(res.status).toBe(405);
    });
  });
});
