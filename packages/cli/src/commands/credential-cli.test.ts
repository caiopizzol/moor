import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint = "/api/server/source-credentials";
const secret = "credential-private-fixture";
const input = { hostname: "github.com", label: "work", username: "git", secret };
const metadata = {
  id: 8,
  hostname: "github.com",
  label: "work",
  username: "git",
  secret: { configured: true, kind: "unknown" },
  state: "active",
  expires_at: null,
  last_checked_at: null,
  last_check_status: null,
  created_at: "2026-09-05",
  updated_at: "2026-09-05",
};
let server: ReturnType<typeof Bun.serve>;
let directory: string;
let respond: () => Response;
const requests: Array<{ path: string; method: string; auth: string | null; body: unknown }> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moor-credential-"));
  requests.length = 0;
  respond = () => Response.json(metadata);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        method: req.method,
        auth: req.headers.get("Authorization"),
        body: req.method === "GET" ? null : await req.json(),
      });
      return respond();
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], stdin = "") {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../index.ts"), "credential", ...args],
    env: { ...process.env, MOOR_URL: server.url.origin, MOOR_API_KEY: "test-key" },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
test("source check preserves ambiguous credential candidates in JSON stderr", async () => {
  const body = {
    ok: false,
    code: "source_credential_ambiguous",
    hostname: "github.com",
    candidates: [
      { id: 7, label: "personal" },
      { id: 8, label: "work" },
    ],
  };
  respond = () => Response.json(body, { status: 409 });
  expect(
    await run(["source", "check", "--github-url", "https://github.com/acme/app", "--json"]),
  ).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({ ...body, error: "HTTP 409", status: 409 })}\n`,
  });
  expect(requests).toEqual([
    {
      path: `${endpoint}/check`,
      method: "POST",
      auth: "Bearer test-key",
      body: { github_url: "https://github.com/acme/app" },
    },
  ]);
});
test("source create reads stdin and returns only server metadata", async () => {
  const result = await run(["source", "create", "--file", "-", "--json"], JSON.stringify(input));
  expect(result).toEqual({ exitCode: 0, stdout: `${JSON.stringify(metadata)}\n`, stderr: "" });
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(requests).toEqual([
    { path: endpoint, method: "POST", auth: "Bearer test-key", body: input },
  ]);
});
test("source update rotates through one PUT without checking or changing failed metadata", async () => {
  const failed = { ...metadata, state: "failed" };
  respond = () => Response.json(failed);
  const body = { secret, expires_at: null };
  expect(
    await run(
      ["source", "update", "--source-credential-id", "8", "--file", "-", "--json"],
      JSON.stringify(body),
    ),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(failed)}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: `${endpoint}/8`, method: "PUT", auth: "Bearer test-key", body },
  ]);
  const checked = { ok: true, reachable: true, head_sha: "abc" };
  respond = () => Response.json(checked);
  expect(
    (
      await run([
        "source",
        "check",
        "--source-credential-id",
        "8",
        "--github-url",
        "https://github.com/acme/app",
        "--json",
      ])
    ).exitCode,
  ).toBe(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({
    path: `${endpoint}/check`,
    method: "POST",
    auth: "Bearer test-key",
    body: { github_url: "https://github.com/acme/app", source_credential_id: 8 },
  });
});
test("source update reads disk patches without adding omitted fields", async () => {
  const path = join(directory, "rotation.json");
  const body = { username: "new-user", label: "renamed", secret };
  await writeFile(path, JSON.stringify(body));
  respond = () => Response.json({ ...metadata, label: "renamed" });
  expect(await run(["source", "update", "--file", path, "--source-credential-id", "8"])).toEqual({
    exitCode: 0,
    stdout: "8\tgithub.com\trenamed\tactive\n",
    stderr: "",
  });
  expect(requests).toEqual([
    { path: `${endpoint}/8`, method: "PUT", auth: "Bearer test-key", body },
  ]);
});
test("source update accepts an empty patch and renders failed metadata honestly", async () => {
  respond = () => Response.json({ ...metadata, state: "failed" });
  expect(
    await run(["source", "update", "--source-credential-id", "8", "--file", "-"], "{}"),
  ).toEqual({ exitCode: 0, stdout: "8\tgithub.com\twork\tfailed\n", stderr: "" });
  expect(requests).toEqual([
    { path: `${endpoint}/8`, method: "PUT", auth: "Bearer test-key", body: {} },
  ]);
});
test("source update preserves API failures and leaves field validation to the server", async () => {
  for (const status of [400, 404, 409, 500]) {
    requests.length = 0;
    respond = () => Response.json({ error: "update rejected", code: "fixture" }, { status });
    expect(
      await run(
        ["source", "update", "--source-credential-id", "8", "--file", "-", "--json"],
        JSON.stringify({ hostname: "other.host", secret }),
      ),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${JSON.stringify({ error: "update rejected", code: "fixture", status })}\n`,
    });
    expect(requests).toEqual([
      {
        path: `${endpoint}/8`,
        method: "PUT",
        auth: "Bearer test-key",
        body: { hostname: "other.host", secret },
      },
    ]);
  }
});
test("source update rejects invalid IDs, arguments and input before requesting", async () => {
  for (const id of ["0", "-1", "1.5", "9007199254740992", "Infinity", "bad"]) {
    const result = await run(
      ["source", "update", "--source-credential-id", id, "--file", "-", "--json"],
      JSON.stringify({ secret }),
    );
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"--source-credential-id must be a positive integer"}\n',
    });
  }
  for (const args of [
    [],
    ["--file", "-"],
    ["--source-credential-id", "8"],
    ["--source-credential-id", "8", "--file", "-", "extra"],
    ["--source-credential-id", "8", "--file", "-", "--secret", secret],
    ["--source-credential-id", "8", "--source-credential-id", "9", "--file", "-"],
  ]) {
    const result = await run(["source", "update", ...args, "--json"], JSON.stringify({ secret }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(result.stderr).not.toContain(secret);
  }
  for (const body of [`{"secret":"${secret}"`, "[]", "null"]) {
    expect(
      await run(["source", "update", "--source-credential-id", "8", "--file", "-", "--json"], body),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Credential file must contain a JSON object"}\n',
    });
  }
  expect(requests).toEqual([]);
});
test("source create reads a disk file and prints a minimal human summary", async () => {
  const path = join(directory, "credential.json");
  await writeFile(path, JSON.stringify(input));
  expect(await run(["source", "create", "--file", path])).toEqual({
    exitCode: 0,
    stdout: "8\tgithub.com\twork\tactive\n",
    stderr: "",
  });
  expect(requests[0]?.body).toEqual(input);
  expect(requests).toHaveLength(1);
});
test("source list preserves metadata JSON and handles empty human output", async () => {
  respond = () => Response.json({ rows: [metadata] });
  expect(await run(["source", "list", "--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify({ rows: [metadata] })}\n`,
    stderr: "",
  });
  expect(requests).toEqual([
    { path: endpoint, method: "GET", auth: "Bearer test-key", body: null },
  ]);
  respond = () => Response.json({ rows: [] });
  expect((await run(["source", "list"])).stdout).toBe("No source credentials.\n");
  expect(requests).toHaveLength(2);
});
test("source check forwards explicit selection and preserves the selected credential response", async () => {
  const body = { ok: true, reachable: true, head_sha: "abc" };
  respond = () => Response.json(body);
  expect(
    await run([
      "source",
      "check",
      "--json",
      "--source-credential-id",
      "8",
      "--branch",
      "next",
      "--github-url",
      "https://github.com/acme/app",
    ]),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: "",
  });
  expect(requests[0]?.body).toEqual({
    github_url: "https://github.com/acme/app",
    branch: "next",
    source_credential_id: 8,
  });
  const selected = { ...body, auto_selected_credential_id: 8 };
  respond = () => Response.json(selected);
  expect(
    await run(["source", "check", "--github-url", "https://github.com/acme/app", "--json"]),
  ).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify(selected)}\n`,
    stderr: "",
  });
  expect(requests[1]?.body).toEqual({ github_url: "https://github.com/acme/app" });
  expect(requests).toHaveLength(2);
});

test("human credential output rejects malformed metadata without partial stdout", async () => {
  for (const row of [
    {},
    null,
    { ...metadata, id: 0 },
    { ...metadata, hostname: 42 },
    { ...metadata, label: null },
    { ...metadata, state: "unknown" },
  ]) {
    for (const verb of ["list", "create", "update"]) {
      requests.length = 0;
      respond = () => Response.json(verb === "list" ? { rows: [metadata, row] } : row);
      expect(
        await run(
          [
            "source",
            verb,
            ...(verb !== "list" ? ["--file", "-"] : []),
            ...(verb === "update" ? ["--source-credential-id", "8"] : []),
          ],
          JSON.stringify(input),
        ),
      ).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Error: Invalid credential response\n",
      });
      expect(requests).toHaveLength(1);
    }
  }
});
test("source create parse failures never echo credential content", async () => {
  for (const value of [`{"secret":"${secret}"`, "[]", "null", '"value"']) {
    expect(await run(["source", "create", "--file", "-", "--json"], value)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"Credential file must contain a JSON object"}\n',
    });
  }
  expect(await run(["source", "create", "--file", join(directory, "absent"), "--json"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"Unable to read credential file"}\n',
  });
  expect(requests).toEqual([]);
});
test("credential syntax errors and help make no requests", async () => {
  for (const args of [
    [],
    ["unknown", "list"],
    ["source", "delete"],
    ["source", "list", "extra"],
    ["source", "create"],
    ["source", "create", "--secret", secret],
    ["source", "create", "--file", "a", "--file", "b"],
    ["source", "create", "--file"],
    ["source", "check"],
    ["source", "check", "--github-url", "url", "--source-credential-id", "0"],
    ["source", "check", "--github-url", "url", "--source-credential-id", "1.5"],
    ["source", "check", "--github-url", "url", "--branch", " "],
  ]) {
    const result = await run([...args, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(result.stderr).not.toContain(secret);
  }
  const help = await run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("credential source check");
  expect(requests).toEqual([]);
});
test("source create leaves field validation on the server and preserves errors without secrets", async () => {
  respond = () => Response.json({ error: "hostname is required" }, { status: 400 });
  const result = await run(
    ["source", "create", "--file", "-", "--json"],
    JSON.stringify({ secret }),
  );
  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: '{"error":"hostname is required","status":400}\n',
  });
  expect(requests[0]?.body).toEqual({ secret });
  expect(result.stdout + result.stderr).not.toContain(secret);
});

const registryEndpoint = "/api/server/registry-credentials";
const registryMetadata = {
  id: 9,
  hostname: "ghcr.io",
  username: "operator",
  secret: { configured: true, kind: "unknown" },
  created_at: "2026-09-05",
  updated_at: "2026-09-05",
};
test("registry list uses its own endpoint and renders metadata in both modes", async () => {
  respond = () => Response.json({ rows: [registryMetadata] });
  expect(await run(["registry", "list", "--json"])).toEqual({
    exitCode: 0,
    stdout: `${JSON.stringify({ rows: [registryMetadata] })}\n`,
    stderr: "",
  });
  expect(await run(["registry", "list"])).toEqual({
    exitCode: 0,
    stdout: "9\tghcr.io\toperator\n",
    stderr: "",
  });
  respond = () => Response.json({ rows: [] });
  expect((await run(["registry", "list"])).stdout).toBe("No registry credentials.\n");
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({
      path: registryEndpoint,
      method: "GET",
      auth: "Bearer test-key",
      body: null,
    })),
  );
});
test("registry create reads disk and stdin without rewriting hostnames or echoing secrets", async () => {
  for (const file of ["-", join(directory, "registry.json")]) {
    requests.length = 0;
    const body = { hostname: "REGISTRY.example.com:5000", username: "operator", secret };
    if (file !== "-") await writeFile(file, JSON.stringify(body));
    respond = () => Response.json(registryMetadata, { status: 201 });
    expect(
      await run(["registry", "create", "--file", file, "--json"], JSON.stringify(body)),
    ).toEqual({ exitCode: 0, stdout: `${JSON.stringify(registryMetadata)}\n`, stderr: "" });
    expect(requests).toEqual([
      { path: registryEndpoint, method: "POST", auth: "Bearer test-key", body },
    ]);
  }
});
test("registry update sends one exact patch and no check or image pull", async () => {
  for (const body of [{ secret }, { username: "new-user" }, {}]) {
    requests.length = 0;
    respond = () => Response.json(registryMetadata);
    expect(
      await run(
        ["registry", "update", "--registry-credential-id", "9", "--file", "-", "--json"],
        JSON.stringify(body),
      ),
    ).toEqual({ exitCode: 0, stdout: `${JSON.stringify(registryMetadata)}\n`, stderr: "" });
    expect(requests).toEqual([
      { path: `${registryEndpoint}/9`, method: "PUT", auth: "Bearer test-key", body },
    ]);
  }
});
test("registry human writes use registry metadata and buffer malformed rows", async () => {
  for (const verb of ["create", "update"]) {
    requests.length = 0;
    respond = () => Response.json(registryMetadata);
    const args = [
      "registry",
      verb,
      "--file",
      "-",
      ...(verb === "update" ? ["--registry-credential-id", "9"] : []),
    ];
    expect(await run(args, JSON.stringify({ secret }))).toEqual({
      exitCode: 0,
      stdout: "9\tghcr.io\toperator\n",
      stderr: "",
    });
    expect(requests).toHaveLength(1);
  }
  for (const row of [
    null,
    {},
    { ...registryMetadata, id: 0 },
    { ...registryMetadata, hostname: 12 },
    { ...registryMetadata, username: " " },
  ]) {
    for (const verb of ["list", "create", "update"]) {
      requests.length = 0;
      respond = () => Response.json(verb === "list" ? { rows: [registryMetadata, row] } : row);
      const args = [
        "registry",
        verb,
        ...(verb !== "list" ? ["--file", "-"] : []),
        ...(verb === "update" ? ["--registry-credential-id", "9"] : []),
      ];
      expect(await run(args, "{}")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Error: Invalid credential response\n",
      });
      expect(requests).toHaveLength(1);
    }
  }
});
test("registry syntax, kind-specific options and invalid files fail without requests", async () => {
  for (const args of [
    ["registry", "check"],
    ["registry", "delete"],
    ["registry", "list", "extra"],
    ["registry", "create"],
    ["registry", "create", "--file"],
    ["registry", "create", "--file", "-", "--file", "-"],
    ["registry", "create", "--secret", secret],
    ["registry", "update", "--file", "-"],
    ["registry", "update", "--source-credential-id", "9", "--file", "-"],
    ["source", "update", "--registry-credential-id", "9", "--file", "-"],
    ...["0", "-1", "1.5", "9007199254740992", "no"].map((id) => [
      "registry",
      "update",
      "--registry-credential-id",
      id,
      "--file",
      "-",
    ]),
  ]) {
    const result = await run([...args, "--json"], "{}");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(typeof JSON.parse(result.stderr).error).toBe("string");
    expect(result.stderr).not.toContain(secret);
  }
  for (const verb of ["create", "update"]) {
    for (const value of [`{"secret":"${secret}"`, "null", "[]"]) {
      expect(
        await run(
          [
            "registry",
            verb,
            "--file",
            "-",
            ...(verb === "update" ? ["--registry-credential-id", "9"] : []),
            "--json",
          ],
          value,
        ),
      ).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: '{"error":"Credential file must contain a JSON object"}\n',
      });
    }
  }
  expect(requests).toEqual([]);
});
test("registry request failures retain status and server validation details", async () => {
  for (const verb of ["list", "create", "update"]) {
    requests.length = 0;
    respond = () => Response.json({ error: "rejected", code: "fixture" }, { status: 409 });
    expect(
      await run(
        [
          "registry",
          verb,
          ...(verb !== "list" ? ["--file", "-"] : []),
          ...(verb === "update" ? ["--registry-credential-id", "9"] : []),
          "--json",
        ],
        JSON.stringify({ hostname: "blocked-on-update", secret }),
      ),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: '{"error":"rejected","code":"fixture","status":409}\n',
    });
    expect(requests).toEqual([
      {
        path: verb === "update" ? `${registryEndpoint}/9` : registryEndpoint,
        method: verb === "list" ? "GET" : verb === "create" ? "POST" : "PUT",
        auth: "Bearer test-key",
        body: verb === "list" ? null : { hostname: "blocked-on-update", secret },
      },
    ]);
  }
});
