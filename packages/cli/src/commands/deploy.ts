import { readFile } from "node:fs/promises";
import type { DeployRequest, DeploySummary } from "../../../contract/src/index";
import { apiPost, streamSSE } from "../client";
import {
  type CommandOutput,
  defaultCommandOutput,
  formatError,
  formatResponseError,
} from "../protocol";

const USAGE = `Usage: moor project deploy <name> [options]

Options:
  --github-url <url>       Deploy a GitHub repository
  --docker-image <image>   Deploy a registry image
  --branch <branch>        Git branch (default: main)
  --dockerfile <path>      Dockerfile path (default: Dockerfile)
  --domain <domain>        Route a public domain to the project
  --domain-port <port>     Container port for the public domain
  --source-credential-id <id> Select a stored credential for a private repository
  --env-file <path|->      Merge env from a JSON object; - reads stdin
  --files <path|->         Upsert files from a JSON array; - reads stdin
  --volume <name>:<target> Add a named volume at an absolute container path (repeatable)
  --update-existing        Update a project with the same name
  --no-run                 Save configuration without building or starting
  --json                   Emit one {event,data} JSON object per line`;

type DeployOutput = CommandOutput & {
  readText: (path: string) => Promise<string>;
};

type ParsedDeployArgs = {
  input?: DeployRequest;
  envFile?: string;
  filesFile?: string;
  json: boolean;
  error?: string;
};

const defaultOutput: DeployOutput = {
  ...defaultCommandOutput,
  readText: async (path) => (path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8")),
};

export function parseDeployArgs(args: string[]): ParsedDeployArgs {
  const input: DeployRequest = { name: "" };
  let envFile: string | undefined;
  let filesFile: string | undefined;
  const json = args.includes("--json");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("-") && !input.name) {
      input.name = arg;
      continue;
    }
    if (arg === "--update-existing") {
      input.update_existing = true;
      continue;
    }
    if (arg === "--no-run") {
      input.run = false;
      continue;
    }
    if (arg === "--json") {
      continue;
    }

    if (
      ![
        "--github-url",
        "--docker-image",
        "--branch",
        "--dockerfile",
        "--domain",
        "--domain-port",
        "--source-credential-id",
        "--env-file",
        "--files",
        "--volume",
      ].includes(arg)
    ) {
      return { json, error: `Unknown option: ${arg}` };
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      return { json, error: `${arg} requires a value` };
    }
    index += 1;
    switch (arg) {
      case "--files":
        if (filesFile !== undefined) return { json, error: "--files may be used only once" };
        filesFile = value;
        break;
      case "--volume": {
        const separator = value.indexOf(":");
        if (separator <= 0 || !value.slice(separator + 1).startsWith("/")) {
          return { json, error: "--volume requires <name>:<absolute-container-path>" };
        }
        if (value.indexOf(":", separator + 1) !== -1) {
          return { json, error: "--volume does not support mount modes or colons in targets" };
        }
        input.volumes ??= [];
        input.volumes.push({
          name: value.slice(0, separator),
          target: value.slice(separator + 1),
        });
        break;
      }
      case "--github-url":
        input.github_url = value;
        break;
      case "--docker-image":
        input.docker_image = value;
        break;
      case "--branch":
        input.branch = value;
        break;
      case "--dockerfile":
        input.dockerfile = value;
        break;
      case "--domain":
        input.domain = value;
        break;
      case "--domain-port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0) {
          return { json, error: "--domain-port must be a positive integer" };
        }
        input.domain_port = port;
        break;
      }
      case "--source-credential-id": {
        const credentialId = Number(value);
        if (!Number.isInteger(credentialId) || credentialId <= 0) {
          return { json, error: "--source-credential-id must be a positive integer" };
        }
        input.source_credential_id = credentialId;
        break;
      }
      case "--env-file":
        envFile = value;
        break;
    }
  }

  if (!input.name) return { json, error: "Project name is required" };
  if (envFile === "-" && filesFile === "-") {
    return { json, error: "--env-file and --files cannot both read stdin" };
  }
  if (input.github_url && input.docker_image) {
    return { json, error: "Use only one of --github-url or --docker-image" };
  }
  return { input, envFile, ...(filesFile === undefined ? {} : { filesFile }), json };
}

export async function deployCommand(
  args: string[],
  output: DeployOutput = defaultOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }

  const parsed = parseDeployArgs(args);
  if (!parsed.input) {
    output.stderr(`${formatError(parsed.error ?? "Invalid arguments", undefined, parsed.json)}\n`);
    if (!parsed.json) output.stderr(`${USAGE}\n`);
    return 1;
  }

  if (parsed.envFile) {
    try {
      parsed.input.env = parseEnvJson(await output.readText(parsed.envFile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(
        `${formatError(`Failed to read --env-file: ${message}`, undefined, parsed.json)}\n`,
      );
      return 1;
    }
  }

  if (parsed.filesFile) {
    try {
      const text = await output.readText(parsed.filesFile);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("expected a JSON array of file entries");
      }
      if (!Array.isArray(value)) throw new Error("expected a JSON array of file entries");
      parsed.input.files = value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.stderr(
        `${formatError(`Failed to read --files: ${message}`, undefined, parsed.json)}\n`,
      );
      return 1;
    }
  }

  let response: Response;
  try {
    response = await apiPost("/api/deploy", parsed.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.stderr(`${formatError(message, undefined, parsed.json)}\n`);
    return 1;
  }
  if (!response.ok) {
    output.stderr(`${await formatResponseError(response, parsed.json)}\n`);
    return 1;
  }

  let failed = false;
  let sawDeploy = false;
  let sawStructuredError = false;
  try {
    await streamSSE(response, {
      onEvent: ({ event, data }) => {
        if (event === "deploy" && isDeploySummary(data)) sawDeploy = true;
        if (parsed.json) {
          output.stdout(`${JSON.stringify({ event, data })}\n`);
          if (event === "error" || event === "structured-error") failed = true;
          return;
        }
        if (event === "deploy" && isDeploySummary(data)) {
          output.stdout(
            `${data.action === "created" ? "Created" : "Updated"} project ${data.project_name} (id=${data.project_id}).\n`,
          );
          if (data.env_keys.length > 0) {
            output.stdout(
              `Merged ${data.env_keys.length} env var(s): ${data.env_keys.join(", ")}.\n`,
            );
          }
          if (data.env_changes_pending_restart) {
            output.stdout(
              "Note: project is running; env changes take effect on the next run or restart.\n",
            );
          }
        } else if (event === "log" && typeof data === "string") output.stdout(data);
        else if (event === "done" && typeof data === "string") output.stdout(`${data}\n`);
        else if (event === "structured-error" && isStructuredError(data)) {
          output.stderr(`Error [${data.code}]: ${data.message}\n`);
          sawStructuredError = true;
          failed = true;
        } else if (event === "error" && typeof data === "string") {
          if (!sawStructuredError) output.stderr(`Error: ${data}\n`);
          failed = true;
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      output.stdout(`${JSON.stringify({ event: "error", data: message })}\n`);
    } else {
      output.stderr(`${formatError(message, undefined, false)}\n`);
    }
    return 1;
  }

  if (!sawDeploy) {
    output.stderr(
      `${formatError("Deploy response did not include project metadata", undefined, parsed.json)}\n`,
    );
    return 1;
  }
  return failed ? 1 : 0;
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

function isDeploySummary(value: unknown): value is DeploySummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Partial<DeploySummary>;
  return (
    (summary.action === "created" || summary.action === "updated") &&
    typeof summary.project_id === "number" &&
    typeof summary.project_name === "string" &&
    Array.isArray(summary.env_keys) &&
    summary.env_keys.every((key) => typeof key === "string") &&
    typeof summary.run === "boolean" &&
    typeof summary.env_changes_pending_restart === "boolean"
  );
}

function isStructuredError(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const error = value as { code?: unknown; message?: unknown };
  return typeof error.code === "string" && typeof error.message === "string";
}
