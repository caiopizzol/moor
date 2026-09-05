import type { Project } from "../../../contract/src/index";
import { apiGet, apiPost, findProject } from "../client";
import { parseProjectArguments } from "../project-arguments";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage: moor exec <project> [--json] -- <shell command>
       moor exec <project> <shell command>

--json requires -- before the command. Quote shell expressions to prevent local expansion.
Arguments after -- are joined with spaces and sent as a shell command, not an argv array.`;

export async function execCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  const boundary = args.indexOf("--");
  const separator =
    boundary > 1 && !args[0]?.startsWith("-") && !args[1]?.startsWith("-") ? -1 : boundary;
  const prefix = separator < 0 ? args.slice(0, 1) : args.slice(0, separator);
  const json = prefix.includes("--json") || (separator < 0 && args[1] === "--json");
  if (separator < 0 && json) {
    writeError(output, "--json requires -- before the command", true);
    return 1;
  }
  const parsed = parseProjectArguments(prefix, USAGE, output);
  if (typeof parsed === "number") return parsed;
  const command = args.slice(separator < 0 ? 1 : separator + 1).join(" ");
  if (!command.trim()) {
    writeError(output, "Command is required", json);
    return 1;
  }
  const projects = await requestJson<Project[]>(
    () => apiGet("/api/projects"),
    json,
    "Failed to list projects",
    output,
  );
  if (!projects.ok) return 1;
  const project = findProject(projects.value, parsed.selector);
  if (!project) {
    writeError(output, `Project "${parsed.selector}" not found`, json);
    return 1;
  }
  const response = await requestJson<{ exitCode: number; stdout: string; stderr: string }>(
    () => apiPost(`/api/projects/${project.id}/exec`, { command }),
    json,
    "Failed to execute command",
    output,
  );
  if (!response.ok) return 1;
  const result = response.value;
  if (
    !result ||
    !Number.isInteger(result.exitCode) ||
    result.exitCode < 0 ||
    result.exitCode > 255 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    writeError(output, "Invalid exec response", json);
    return 1;
  }
  if (json) output.stdout(`${JSON.stringify(result)}\n`);
  else {
    output.stdout(result.stdout);
    output.stderr(result.stderr);
  }
  return result.exitCode;
}
