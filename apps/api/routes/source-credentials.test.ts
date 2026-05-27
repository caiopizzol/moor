// Integration tests for /api/server/source-credentials. In-memory
// SQLite; no Docker, no git. Covers happy CRUD, write-only read shape,
// multi-credential-per-host disambiguation by label, confirm_label on
// delete, structured credential_in_use, strict boundary validation,
// and the /check endpoint with an injected fake ls-remote runner.

process.env.MOOR_DB_PATH = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";

import type { LsRemoteRequest, LsRemoteRunResult } from "../git-ls-remote";

const { default: db } = await import("../db");
const { handleSourceCredentials, setCheckRunnerForTesting } = await import("./source-credentials");

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await handleSourceCredentials(req, new URL(req.url));
  if (!res) throw new Error(`handler returned null for ${method} ${path}`);
  return res;
}

function insertProject(name: string, source_credential_id: number | null = null): { id: number } {
  return db
    .query(
      "INSERT INTO projects (name, github_url, branch, dockerfile, restart_policy, source_credential_id) VALUES (?, 'https://github.com/owner/' || ?, 'main', 'Dockerfile', 'unless-stopped', ?) RETURNING id",
    )
    .get(name, name, source_credential_id) as { id: number };
}

describe("/api/server/source-credentials", () => {
  beforeEach(() => {
    db.query("DELETE FROM projects").run();
    db.query("DELETE FROM source_credentials").run();
  });

  describe("POST (create)", () => {
    test("happy path returns 201, metadata, no raw secret", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "github_pat_11ABCDEFG_secretmaterial",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        hostname: string;
        label: string;
        username: string;
        secret: { configured: true; kind: string };
        state: string;
      };
      expect(body.hostname).toBe("github.com");
      expect(body.label).toBe("personal");
      expect(body.secret).toEqual({ configured: true, kind: "github_fine_grained_pat" });
      expect(body.state).toBe("active");
      expect(JSON.stringify(body).includes("secretmaterial")).toBe(false);
    });

    test("normalizes hostname casing and trims label", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "GITHUB.COM",
        label: "  spaced  ",
        username: "u",
        secret: "ghp_x",
      });
      const body = (await res.json()) as { hostname: string; label: string };
      expect(body.hostname).toBe("github.com");
      expect(body.label).toBe("spaced");
    });

    test("rejects state on create (server-managed)", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_x",
        state: "active",
      });
      expect(res.status).toBe(400);
    });

    test("rejects auth_type on create (v1 PAT only)", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_x",
        auth_type: "https_token",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/auth_type/);
    });

    test("rejects public_key on create (v1 PAT only; no silent ignore of SSH-shaped fields)", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_x",
        public_key: "ssh-ed25519 AAA test@host",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/public_key/);
    });

    test("requires username", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/username/);
    });

    test("two github.com credentials with different labels coexist", async () => {
      const r1 = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_a",
      });
      expect(r1.status).toBe(201);
      const r2 = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "work",
        username: "u",
        secret: "ghp_b",
      });
      expect(r2.status).toBe(201);
    });

    test("duplicate (hostname, label) returns 409", async () => {
      await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_a",
      });
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_b",
      });
      expect(res.status).toBe(409);
    });

    test("malformed JSON → 400", async () => {
      const res = await call("POST", "/api/server/source-credentials", "{not json");
      expect(res.status).toBe(400);
    });

    test("array body → 400", async () => {
      const res = await call("POST", "/api/server/source-credentials", [
        { hostname: "x", label: "y", username: "u", secret: "s" },
      ]);
      expect(res.status).toBe(400);
    });

    test("URL-shaped hostname → 400", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: "https://github.com",
        label: "x",
        username: "u",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
    });

    test("non-string hostname → 400", async () => {
      const res = await call("POST", "/api/server/source-credentials", {
        hostname: 42,
        label: "x",
        username: "u",
        secret: "ghp_x",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET (list and by id)", () => {
    test("empty list returns rows:[]", async () => {
      const res = await call("GET", "/api/server/source-credentials");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[] };
      expect(body.rows).toEqual([]);
    });

    test("list returns metadata only, no raw secret material", async () => {
      await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_thisistheraw",
      });
      const res = await call("GET", "/api/server/source-credentials");
      const body = (await res.json()) as { rows: Array<{ secret: unknown }> };
      expect(body.rows).toHaveLength(1);
      expect(JSON.stringify(body).includes("thisistheraw")).toBe(false);
    });

    test("get by id returns metadata; 404 on missing", async () => {
      const created = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      const { id } = (await created.json()) as { id: number };
      const res = await call("GET", `/api/server/source-credentials/${id}`);
      expect(res.status).toBe(200);
      const miss = await call("GET", "/api/server/source-credentials/99999");
      expect(miss.status).toBe(404);
    });
  });

  describe("PUT (update)", () => {
    async function createOne(): Promise<number> {
      const r = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_old",
      });
      return (await r.json()).id;
    }

    test("rotates secret, kind updates", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, {
        secret: "github_pat_11NEW",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { secret: { kind: string } };
      expect(body.secret.kind).toBe("github_fine_grained_pat");
    });

    test("blocks hostname in patch", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, {
        hostname: "gitlab.com",
      });
      expect(res.status).toBe(400);
    });

    test("blocks auth_type in patch", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, {
        auth_type: "https_token",
      });
      expect(res.status).toBe(400);
    });

    test("blocks state in patch", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, { state: "failed" });
      expect(res.status).toBe(400);
    });

    test("blocks public_key in patch", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, {
        public_key: "ssh-ed25519 AAA",
      });
      expect(res.status).toBe(400);
    });

    test("can patch label, username, expires_at", async () => {
      const id = await createOne();
      const res = await call("PUT", `/api/server/source-credentials/${id}`, {
        label: "renamed",
        username: "bob",
        expires_at: "2026-12-31",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { label: string; username: string; expires_at: string };
      expect(body.label).toBe("renamed");
      expect(body.username).toBe("bob");
      expect(body.expires_at).toBe("2026-12-31");
    });

    test("missing id → 404", async () => {
      const res = await call("PUT", "/api/server/source-credentials/99999", { secret: "ghp_x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE", () => {
    async function createOne(label: string): Promise<number> {
      const r = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label,
        username: "u",
        secret: "ghp_a",
      });
      return (await r.json()).id;
    }

    test("delete without confirm_label → 400", async () => {
      const id = await createOne("personal");
      const res = await call("DELETE", `/api/server/source-credentials/${id}`);
      expect(res.status).toBe(400);
    });

    test("delete with wrong confirm_label → 400", async () => {
      const id = await createOne("personal");
      const res = await call("DELETE", `/api/server/source-credentials/${id}?confirm_label=work`);
      expect(res.status).toBe(400);
    });

    test("delete with correct confirm_label → 204", async () => {
      const id = await createOne("personal");
      const res = await call(
        "DELETE",
        `/api/server/source-credentials/${id}?confirm_label=personal`,
      );
      expect(res.status).toBe(204);
      const after = await call("GET", `/api/server/source-credentials/${id}`);
      expect(after.status).toBe(404);
    });

    test("delete referenced credential → 409 credential_in_use with project list", async () => {
      const id = await createOne("personal");
      insertProject("my-app", id);
      insertProject("other-app", id);
      const res = await call(
        "DELETE",
        `/api/server/source-credentials/${id}?confirm_label=personal`,
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; projects: string[] };
      expect(body.error).toBe("credential_in_use");
      expect(body.projects.sort()).toEqual(["my-app", "other-app"]);
    });

    test("delete missing → 404", async () => {
      const res = await call("DELETE", "/api/server/source-credentials/99999?confirm_label=x");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /check", () => {
    function installRunner(plan: (req: LsRemoteRequest) => LsRemoteRunResult): void {
      setCheckRunnerForTesting(async (req) => plan(req));
    }

    beforeEach(() => {
      setCheckRunnerForTesting(undefined);
    });

    test("invalid_url → 400", async () => {
      installRunner(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "not-a-url",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid_url");
    });

    test("github_url missing → 400", async () => {
      const res = await call("POST", "/api/server/source-credentials/check", {});
      expect(res.status).toBe(400);
    });

    test("public anonymous reachable → 200 with default_branch", async () => {
      installRunner(() => ({
        exitCode: 0,
        stdout: "ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n",
        stderr: "",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/public-repo",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { default_branch: string };
      expect(body.default_branch).toBe("main");
    });

    test("zero candidates → 401 source_credential_required", async () => {
      installRunner(() => ({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: could not read Username; terminal prompts disabled",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/private-repo",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string; hostname: string };
      expect(body.code).toBe("source_credential_required");
    });

    test("one candidate → auto-selects and returns 200", async () => {
      await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "x-access-token",
        secret: "ghp_x",
      });
      let call_ = 0;
      installRunner(() =>
        call_++ === 0
          ? { exitCode: 128, stdout: "", stderr: "could not read Username", timedOut: false }
          : {
              exitCode: 0,
              stdout:
                "ref: refs/heads/main\tHEAD\nabc1234567890abc1234567890abc1234567890a\tHEAD\n",
              stderr: "",
              timedOut: false,
            },
      );
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/private-repo",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auto_selected_credential_id: number };
      expect(typeof body.auto_selected_credential_id).toBe("number");
    });

    test("multiple candidates → 409 source_credential_ambiguous", async () => {
      await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "personal",
        username: "u",
        secret: "ghp_a",
      });
      await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "work",
        username: "u",
        secret: "ghp_b",
      });
      installRunner(() => ({
        exitCode: 128,
        stdout: "",
        stderr: "could not read Username",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/private-repo",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; candidates: Array<{ label: string }> };
      expect(body.code).toBe("source_credential_ambiguous");
      expect(body.candidates.map((c) => c.label).sort()).toEqual(["personal", "work"]);
    });

    test("explicit credential_id missing → 404", async () => {
      installRunner(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
        source_credential_id: 99999,
      });
      expect(res.status).toBe(404);
    });

    test("auth failed with explicit credential → 401 clone_auth_failed", async () => {
      const created = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      const { id } = (await created.json()) as { id: number };
      installRunner(() => ({
        exitCode: 128,
        stdout: "",
        stderr: "remote: Authentication failed",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
        source_credential_id: id,
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("clone_auth_failed");
    });

    test("credential_host_mismatch → 400 (never sends request)", async () => {
      const created = await call("POST", "/api/server/source-credentials", {
        hostname: "gitlab.com",
        label: "x",
        username: "u",
        secret: "glpat_a",
      });
      const { id } = (await created.json()) as { id: number };
      installRunner(() => ({
        exitCode: 0,
        stdout: "ref: refs/heads/main\tHEAD\nabc1234567890abc1234567890abc1234567890a\tHEAD\n",
        stderr: "",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
        source_credential_id: id,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("credential_host_mismatch");
    });

    test("branch_not_found → 404", async () => {
      const created = await call("POST", "/api/server/source-credentials", {
        hostname: "github.com",
        label: "x",
        username: "u",
        secret: "ghp_a",
      });
      const { id } = (await created.json()) as { id: number };
      installRunner(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
        branch: "missing-branch",
        source_credential_id: id,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; branch: string };
      expect(body.code).toBe("branch_not_found");
    });

    test("network_unreachable → 502", async () => {
      installRunner(() => ({
        exitCode: 128,
        stdout: "",
        stderr: "Could not resolve host: github.com",
        timedOut: false,
      }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
      });
      expect(res.status).toBe(502);
    });

    test("source_credential_id of wrong type → 400", async () => {
      installRunner(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
      const res = await call("POST", "/api/server/source-credentials/check", {
        github_url: "https://github.com/owner/r",
        source_credential_id: "not-a-number",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("dispatcher", () => {
    test("unrelated path returns null (passes through)", async () => {
      const req = new Request("http://localhost/api/projects", { method: "GET" });
      const res = await handleSourceCredentials(req, new URL(req.url));
      expect(res).toBeNull();
    });

    test("unknown method on collection → 405", async () => {
      const res = await call("PATCH", "/api/server/source-credentials");
      expect(res.status).toBe(405);
    });

    test("deploy-key endpoint does not exist (v1 PAT only)", async () => {
      const req = new Request("http://localhost/api/server/source-credentials/deploy-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_url: "https://github.com/owner/r", label: "x" }),
      });
      const res = await handleSourceCredentials(req, new URL(req.url));
      // Falls through (no handler) → null, meaning the dispatcher chain
      // moves on. v1 doesn't ship deploy-key generation; an SSH flow
      // PR would re-introduce it.
      expect(res).toBeNull();
    });
  });
});
