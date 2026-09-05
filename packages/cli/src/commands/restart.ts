import type { Project } from "../../../contract/src/index";
import { apiGet, apiPost, findProject } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = "Usage: moor restart <project> [--json]";

export async function restartCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const option = positional.find((arg) => arg.startsWith("-"));
  const selector = positional[0];
  const error = option
    ? `Unknown option: ${option}`
    : !selector
      ? "Project is required"
      : positional.length > 1
        ? `Unexpected argument: ${positional[1]}`
        : undefined;
  if (error || !selector) {
    writeError(output, error ?? "Project is required", json);
    if (!json) output.stderr(`${USAGE}\n`);
    return 1;
  }
  const projects = await requestJson<Project[]>(
    () => apiGet("/api/projects"),
    json,
    "Failed to list projects",
    output,
  );
  if (!projects.ok) return 1;
  const project = findProject(projects.value, selector);
  if (!project) {
    writeError(output, `Project "${selector}" not found`, json);
    return 1;
  }
  if (!json) output.stdout(`Restarting ${project.name}...\n`);
  const result = await requestJson<unknown>(
    () => apiPost(`/api/projects/${project.id}/restart`),
    json,
    "Failed to restart",
    output,
  );
  if (!result.ok) return 1;
  output.stdout(json ? `${JSON.stringify(result.value)}\n` : `${project.name} restarted.\n`);
  return 0;
}
