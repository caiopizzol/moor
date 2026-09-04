import { afterEach, describe, expect, test } from "bun:test";
import type { Project } from "../../../contract/src/index";
import { projectGetCommand, projectListCommand } from "./project";

const originalFetch = globalThis.fetch;
const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

const project: Project = {
  id: 7,
  name: "api",
  github_url: null,
  docker_image: "ghcr.io/example/api:latest",
  branch: "main",
  dockerfile: "Dockerfile",
  image_tag: "moor-api:latest",
  container_id: "container-7",
  status: "running",
  domain: "api.example.com",
  domain_port: 3000,
  restart_policy: "unless-stopped",
  memory_limit_mb: null,
  cpus: null,
  source_credential_id: null,
  command: null,
  entrypoint: null,
  live_status: "running",
  live_exit_code: null,
  live_checked_at: "2026-09-04T12:00:00.000Z",
  live_error: null,
  created_at: "2026-09-04T11:00:00.000Z",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

function configureClient(response: (url: URL) => Response): string[] {
  process.env.MOOR_URL = "https://moor.test";
  process.env.MOOR_API_KEY = "test-key";
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    paths.push(url.pathname);
    return response(url);
  }) as typeof fetch;
  return paths;
}

describe("project inspection commands", () => {
  test("lists projects as one JSON document", async () => {
    const paths = configureClient(() => Response.json([project]));
    const capture = captureOutput();

    const exitCode = await projectListCommand(["--json"], capture.output);

    expect(exitCode).toBe(0);
    expect(paths).toEqual(["/api/projects"]);
    expect(JSON.parse(capture.stdout.join(""))).toEqual([project]);
    expect(capture.stderr).toEqual([]);
  });

  test("keeps the existing human project table", async () => {
    configureClient(() => Response.json([project]));
    const capture = captureOutput();

    const exitCode = await projectListCommand([], capture.output);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("")).toContain("NAME  STATUS");
    expect(capture.stdout.join("")).toContain("api   running");
  });

  test("gets a numeric project directly and emits compact JSON", async () => {
    const paths = configureClient(() => Response.json(project));
    const capture = captureOutput();

    const exitCode = await projectGetCommand(["7", "--json"], capture.output);

    expect(exitCode).toBe(0);
    expect(paths).toEqual(["/api/projects/7"]);
    expect(capture.stdout).toEqual([`${JSON.stringify(project)}\n`]);
    expect(capture.stderr).toEqual([]);
  });

  test("resolves a project name from the list", async () => {
    const paths = configureClient(() => Response.json([project]));
    const capture = captureOutput();

    const exitCode = await projectGetCommand(["api", "--json"], capture.output);

    expect(exitCode).toBe(0);
    expect(paths).toEqual(["/api/projects"]);
    expect(JSON.parse(capture.stdout.join(""))).toEqual(project);
  });

  test("returns a structured not-found error for agents", async () => {
    configureClient(() => Response.json([]));
    const capture = captureOutput();

    const exitCode = await projectGetCommand(["missing", "--json"], capture.output);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"Project \\"missing\\" not found"}\n']);
  });

  test("preserves API errors and rejects extra arguments", async () => {
    configureClient(() => Response.json({ error: "Not found" }, { status: 404 }));
    const apiCapture = captureOutput();
    const argumentCapture = captureOutput();

    expect(await projectGetCommand(["7", "--json"], apiCapture.output)).toBe(1);
    expect(apiCapture.stderr).toEqual(['{"error":"Not found","status":404}\n']);
    expect(await projectGetCommand(["api", "extra", "--json"], argumentCapture.output)).toBe(1);
    expect(argumentCapture.stderr).toEqual(['{"error":"Unexpected argument: extra"}\n']);
  });
});
