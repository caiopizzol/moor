import { readFile } from "node:fs/promises";
import type { EnvVar, MergeEnvVarsResponse, Project } from "../../../contract/src/index";
import { apiGet, apiPost, clientConfigError, findProject, readErrorMessage } from "../client";

export const ENV_USAGE = `Usage:
  moor env list <project>
  moor env set <project> KEY=VALUE [KEY=VALUE ...]
  moor env set <project> --env-file <path|-> [--json]

Options:
  --env-file <path|->  Read a JSON object of environment values; - reads stdin
  --json               Emit one JSON document; requires --env-file`;

type EnvOutput = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readText: (path: string) => Promise<string>;
};

type ParsedEnvSetArgs = {
  project?: string;
  vars?: Record<string, string>;
  envFile?: string;
  json: boolean;
  error?: string;
};

const defaultOutput: EnvOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readText: async (path) => (path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8")),
};

export async function envCommand(
  args: string[],
  output: EnvOutput = defaultOutput,
): Promise<number> {
  const subcommand = args[0];

  if (subcommand === "list") return envList(args.slice(1), output);
  if (subcommand === "set") return envSet(args.slice(1), output);
  if (subcommand === "--help" || subcommand === "-h") {
    output.stdout(`${ENV_USAGE}\n`);
    return 0;
  }

  output.stderr(`${ENV_USAGE}\n`);
  return 1;
}

async function envList(args: string[], output: EnvOutput): Promise<number> {
  const projectName = args[0];
  if (!projectName) {
    output.stderr("Usage: moor env list <project>\n");
    return 1;
  }

  const project = await getProject(projectName, false, output);
  if (!project) return 1;
  const result = await getJson<EnvVar[]>(
    `/api/projects/${project.id}/envs`,
    false,
    "Failed to get environment variables",
    output,
  );
  if (!result.ok) return 1;

  if (result.value.length === 0) {
    output.stdout("No environment variables set.\n");
    return 0;
  }
  for (const variable of result.value) {
    output.stdout(`${variable.key}=${variable.value}\n`);
  }
  return 0;
}

export function parseEnvSetArgs(args: string[]): ParsedEnvSetArgs {
  let project: string | undefined;
  let envFile: string | undefined;
  const pairs: string[] = [];
  const json = args.includes("--json");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--json") continue;
    if (arg === "--env-file") {
      if (envFile !== undefined)
        return { project, json, error: "--env-file may be used only once" };
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        return { project, json, error: "--env-file requires a value" };
      }
      envFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { project, json, error: `Unknown option: ${arg}` };
    if (!project) {
      project = arg;
      continue;
    }
    pairs.push(arg);
  }

  if (!project) return { json, error: "Project is required" };
  if (envFile && pairs.length > 0) {
    return { project, json, error: "Use either --env-file or KEY=VALUE arguments, not both" };
  }
  if (json && !envFile) {
    return { project, json, error: "--json requires --env-file so values stay out of argv" };
  }
  if (!envFile && pairs.length === 0) {
    return { project, json, error: "Provide KEY=VALUE arguments or --env-file" };
  }

  const vars: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      return { project, json, error: "Environment values must use KEY=VALUE" };
    }
    Object.defineProperty(vars, pair.slice(0, equals), {
      value: pair.slice(equals + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { project, vars, envFile, json };
}

async function envSet(args: string[], output: EnvOutput): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${ENV_USAGE}\n`);
    return 0;
  }

  const parsed = parseEnvSetArgs(args);
  if (!parsed.project || parsed.error) {
    writeError(parsed.error ?? "Project is required", parsed.json, output);
    if (!parsed.json) output.stderr(`${ENV_USAGE}\n`);
    return 1;
  }

  let vars = parsed.vars;
  if (parsed.envFile) {
    try {
      vars = parseEnvJson(await output.readText(parsed.envFile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(`Failed to read --env-file: ${message}`, parsed.json, output);
      return 1;
    }
  }
  if (!vars) {
    writeError("No environment values provided", parsed.json, output);
    return 1;
  }

  const project = await getProject(parsed.project, parsed.json, output);
  if (!project) return 1;
  const result = await postJson<MergeEnvVarsResponse>(
    `/api/projects/${project.id}/envs`,
    { vars },
    parsed.json,
    output,
  );
  if (!result.ok) return 1;

  if (parsed.json) {
    output.stdout(`${JSON.stringify(result.value)}\n`);
    return 0;
  }
  for (const key of result.value.updated_keys) output.stdout(`Set ${key}\n`);
  if (result.value.restarted) output.stdout(`${project.name} restarted.\n`);
  return 0;
}

async function getProject(
  selector: string,
  json: boolean,
  output: EnvOutput,
): Promise<Project | undefined> {
  const projects = await getJson<Project[]>(
    "/api/projects",
    json,
    "Failed to list projects",
    output,
  );
  if (!projects.ok) return;
  const project = findProject(projects.value, selector);
  if (!project) writeError(`Project "${selector}" not found`, json, output);
  return project;
}

async function getJson<T>(
  path: string,
  json: boolean,
  humanError: string,
  output: EnvOutput,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return requestJson(() => apiGet(path), json, humanError, output);
}

async function postJson<T>(
  path: string,
  body: unknown,
  json: boolean,
  output: EnvOutput,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return requestJson(
    () => apiPost(path, body),
    json,
    "Failed to set environment variables",
    output,
  );
}

async function requestJson<T>(
  request: () => Promise<Response>,
  json: boolean,
  humanError: string,
  output: EnvOutput,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const configError = clientConfigError();
  if (configError) {
    writeError(configError, json, output);
    return { ok: false };
  }

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), json, output);
    return { ok: false };
  }
  if (!response.ok) {
    if (json) output.stderr(`${await formatResponseError(response)}\n`);
    else output.stderr(`${humanError}: ${await readErrorMessage(response)}\n`);
    return { ok: false };
  }

  try {
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), json, output);
    return { ok: false };
  }
}

function parseEnvJson(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object of string values");
  }
  if (Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("expected every environment value to be a string");
  }
  return value as Record<string, string>;
}

async function formatResponseError(response: Response): Promise<string> {
  const copy = response.clone();
  const message = await readErrorMessage(response);
  try {
    const body: unknown = await copy.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return JSON.stringify({ ...body, status: response.status });
    }
  } catch {
    // Fall back to the normalized error message below.
  }
  return JSON.stringify({ error: message, status: response.status });
}

function writeError(message: string, json: boolean, output: EnvOutput): void {
  output.stderr(json ? `${JSON.stringify({ error: message })}\n` : `Error: ${message}\n`);
}
