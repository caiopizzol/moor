import type { LogsResponse } from "../../../contract/src/index";
import { apiGet, findProject } from "../client";
import { requestProjects } from "../project-response";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = "Usage: moor logs <project> [-f] [-n <lines>] [--json]";

type LogsOutput = CommandOutput;

type ParsedLogsArgs = {
  project?: string;
  follow: boolean;
  tail: number;
  json: boolean;
  error?: string;
};

const defaultOutput: LogsOutput = defaultCommandOutput;

export function parseLogsArgs(args: string[]): ParsedLogsArgs {
  let project: string | undefined;
  let follow = false;
  let tail = 100;
  const json = args.includes("--json");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--json") continue;
    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }
    if (arg === "-n" || arg === "--lines") {
      const value = args[index + 1];
      if (!value) {
        return { project, follow, tail, json, error: `${arg} requires a value` };
      }
      tail = Number(value);
      if (value.startsWith("-") && Number.isNaN(tail)) {
        return { project, follow, tail, json, error: `${arg} requires a value` };
      }
      if (!Number.isSafeInteger(tail) || tail <= 0) {
        return { project, follow, tail, json, error: `${arg} must be a positive integer` };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return { project, follow, tail, json, error: `Unknown option: ${arg}` };
    }
    if (project) {
      return { project, follow, tail, json, error: `Unexpected argument: ${arg}` };
    }
    project = arg;
  }

  if (!project) return { follow, tail, json, error: "Project is required" };
  if (json && follow) {
    return { project, follow, tail, json, error: "--json cannot be used with --follow" };
  }
  return { project, follow, tail, json };
}

export async function logsCommand(
  args: string[],
  output: LogsOutput = defaultOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }

  const parsed = parseLogsArgs(args);
  if (!parsed.project || parsed.error) {
    writeError(output, parsed.error ?? "Project is required", parsed.json);
    if (!parsed.json) output.stderr(`${USAGE}\n`);
    return 1;
  }

  const projects = await requestProjects(parsed.json, output);
  if (!projects.ok) return 1;
  const project = findProject(projects.value, parsed.project);
  if (!project) {
    writeError(output, `Project "${parsed.project}" not found`, parsed.json);
    return 1;
  }

  const initial = await requestJson<LogsResponse>(
    () => apiGet(`/api/projects/${project.id}/logs?tail=${parsed.tail}`),
    parsed.json,
    "Failed to get logs",
    output,
  );
  if (!initial.ok) return 1;

  if (parsed.json) {
    output.stdout(`${JSON.stringify(initial.value)}\n`);
    return 0;
  }
  if (initial.value.logs) output.stdout(initial.value.logs);
  if (!parsed.follow) return 0;

  let since = initial.value.lastTimestamp ?? 0;
  const poll = async () => {
    try {
      const res = await apiGet(`/api/projects/${project.id}/logs?since=${since}`);
      if (!res.ok) return;
      const data = (await res.json()) as LogsResponse;
      if (data.logs?.trim()) {
        output.stdout(data.logs);
        since = data.lastTimestamp ?? since;
      }
    } catch {
      // Preserve the existing follow behavior: transient poll failures retry silently.
    }
  };

  const interval = setInterval(poll, 2000);
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });

  return await new Promise<number>(() => {});
}
