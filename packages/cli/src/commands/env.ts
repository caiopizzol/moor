import { readFile } from "node:fs/promises";
import type {
  DeleteEnvVarsResponse,
  EnvVar,
  MergeEnvVarsResponse,
  Project,
} from "../../../contract/src/index";
import { apiGet, apiPost, findProject } from "../client";
import { requestProjects } from "../project-response";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

export const ENV_USAGE = `Usage:
  moor env list <project> [--json]
  moor env delete <project> <keys...> [--json]
  moor env set <project> KEY=VALUE [KEY=VALUE ...]
  moor env set <project> --env-file <path|-> [--json]

Options:
  --env-file <path|->  Read a JSON object of environment values; - reads stdin
  --json               Emit one JSON document; env set requires --env-file`;

const ENV_LIST_USAGE = "Usage: moor env list <project> [--json]";

type EnvOutput = CommandOutput & {
  readText: (path: string) => Promise<string>;
};

type ParsedEnvListArgs = {
  project?: string;
  json: boolean;
  error?: string;
};

type ParsedEnvSetArgs = {
  project?: string;
  vars?: Record<string, string>;
  envFile?: string;
  json: boolean;
  error?: string;
};

const defaultOutput: EnvOutput = {
  ...defaultCommandOutput,
  readText: async (path) => (path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8")),
};

export async function envCommand(
  args: string[],
  output: EnvOutput = defaultOutput,
): Promise<number> {
  const subcommand = args[0];

  if (subcommand === "list") return envList(args.slice(1), output);
  if (subcommand === "set") return envSet(args.slice(1), output);
  if (subcommand === "delete") return envDelete(args.slice(1), output);
  if (subcommand === "--help" || subcommand === "-h") {
    output.stdout(`${ENV_USAGE}\n`);
    return 0;
  }

  output.stderr(`${ENV_USAGE}\n`);
  return 1;
}

async function envList(args: string[], output: EnvOutput): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${ENV_LIST_USAGE}\n`);
    return 0;
  }

  const parsed = parseEnvListArgs(args);
  if (!parsed.project || parsed.error) {
    writeError(output, parsed.error ?? "Project is required", parsed.json);
    if (!parsed.json) output.stderr(`${ENV_LIST_USAGE}\n`);
    return 1;
  }

  const project = await getProject(parsed.project, parsed.json, output);
  if (!project) return 1;
  const result = await requestJson<EnvVar[]>(
    () => apiGet(`/api/projects/${project.id}/envs`),
    parsed.json,
    "Failed to get environment variables",
    output,
  );
  if (!result.ok) return 1;

  if (parsed.json) {
    output.stdout(`${JSON.stringify(result.value)}\n`);
    return 0;
  }
  if (result.value.length === 0) {
    output.stdout("No environment variables set.\n");
    return 0;
  }
  for (const variable of result.value) {
    output.stdout(`${variable.key}=${variable.value}\n`);
  }
  return 0;
}

export function parseEnvListArgs(args: string[]): ParsedEnvListArgs {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const option = positional.find((arg) => arg.startsWith("-"));
  if (option) return { json, error: `Unknown option: ${option}` };
  if (positional.length === 0) return { json, error: "Project is required" };
  if (positional.length > 1) {
    return { project: positional[0], json, error: `Unexpected argument: ${positional[1]}` };
  }
  return { project: positional[0], json };
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
    writeError(output, parsed.error ?? "Project is required", parsed.json);
    if (!parsed.json) output.stderr(`${ENV_USAGE}\n`);
    return 1;
  }

  let vars = parsed.vars;
  if (parsed.envFile) {
    try {
      vars = parseEnvJson(await output.readText(parsed.envFile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(output, `Failed to read --env-file: ${message}`, parsed.json);
      return 1;
    }
  }
  if (!vars) {
    writeError(output, "No environment values provided", parsed.json);
    return 1;
  }

  const project = await getProject(parsed.project, parsed.json, output);
  if (!project) return 1;
  const result = await requestJson<MergeEnvVarsResponse>(
    () => apiPost(`/api/projects/${project.id}/envs`, { vars }),
    parsed.json,
    "Failed to set environment variables",
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

async function envDelete(args: string[], output: EnvOutput): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${ENV_USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const invalid = positional.find((arg) => arg.startsWith("-") || !arg.trim());
  if (invalid !== undefined || positional.length < 2) {
    writeError(
      output,
      invalid !== undefined
        ? "Unexpected option or empty key"
        : "Project and at least one key are required",
      json,
    );
    return 1;
  }
  const project = await getProject(positional[0], json, output);
  if (!project) return 1;
  const result = await requestJson<DeleteEnvVarsResponse>(
    () => apiPost(`/api/projects/${project.id}/envs/delete`, { keys: positional.slice(1) }),
    json,
    "Failed to delete environment variables",
    output,
  );
  if (!result.ok) return 1;
  output.stdout(`${JSON.stringify(result.value, null, json ? undefined : 2)}\n`);
  return 0;
}

async function getProject(
  selector: string,
  json: boolean,
  output: EnvOutput,
): Promise<Project | undefined> {
  const projects = await requestProjects(json, output);
  if (!projects.ok) return;
  const project = findProject(projects.value, selector);
  if (!project) writeError(output, `Project "${selector}" not found`, json);
  return project;
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
