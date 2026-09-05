import type { Project } from "../../../contract/src/index";
import { apiGet, apiPost, findProject } from "../client";
import { parseProjectArguments } from "../project-arguments";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = "Usage: moor restart <project> [--json]";

export async function restartCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  const parsed = parseProjectArguments(args, USAGE, output);
  if (typeof parsed === "number") return parsed;
  const { selector, json } = parsed;
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
