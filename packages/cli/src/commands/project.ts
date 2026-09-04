import type { Project } from "../../../contract/src/index";
import { apiGet, findProject } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

export const PROJECT_USAGE = `Usage:
  moor project list [--json]
  moor project get <name|id> [--json]
  moor project deploy <name> [options]`;

type ProjectOutput = CommandOutput;

const defaultOutput: ProjectOutput = defaultCommandOutput;

export async function projectListCommand(
  args: string[],
  output: ProjectOutput = defaultOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout("Usage: moor project list [--json]\n");
    return 0;
  }

  const parsed = parseJsonArgs(args);
  if (parsed.error) return argumentError(parsed.error, parsed.json, output);

  const result = await requestJson<Project[]>(
    () => apiGet("/api/projects"),
    parsed.json,
    "Failed to list projects",
    output,
  );
  if (!result.ok) return 1;

  if (parsed.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else output.stdout(renderProjectTable(result.value));
  return 0;
}

export async function projectGetCommand(
  args: string[],
  output: ProjectOutput = defaultOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout("Usage: moor project get <name|id> [--json]\n");
    return 0;
  }

  const parsed = parseProjectGetArgs(args);
  if (!parsed.project)
    return argumentError(parsed.error ?? "Project is required", parsed.json, output);

  const result = await requestJson<Project[]>(
    () => apiGet("/api/projects"),
    parsed.json,
    "Failed to list projects",
    output,
  );
  if (!result.ok) return 1;
  const project = findProject(result.value, parsed.project);
  if (!project) {
    writeError(output, `Project "${parsed.project}" not found`, parsed.json);
    return 1;
  }

  output.stdout(`${JSON.stringify(project, null, parsed.json ? undefined : 2)}\n`);
  return 0;
}

function parseJsonArgs(args: string[]): { json: boolean; error?: string } {
  const json = args.includes("--json");
  const unknown = args.find((arg) => arg !== "--json");
  return unknown ? { json, error: `Unknown option: ${unknown}` } : { json };
}

function parseProjectGetArgs(args: string[]): {
  project?: string;
  json: boolean;
  error?: string;
} {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const option = positional.find((arg) => arg.startsWith("-"));
  if (option) return { json, error: `Unknown option: ${option}` };
  if (positional.length === 0) return { json, error: "Project is required" };
  if (positional.length > 1) return { json, error: `Unexpected argument: ${positional[1]}` };
  return { project: positional[0], json };
}

function argumentError(message: string, json: boolean, output: ProjectOutput): number {
  writeError(output, message, json);
  return 1;
}

function renderProjectTable(projects: Project[]): string {
  if (projects.length === 0) return "No projects found.\n";

  const nameWidth = Math.max(4, ...projects.map((project) => project.name.length));
  const statusWidth = Math.max(6, ...projects.map((project) => project.status.length));
  const sourceWidth = Math.max(
    6,
    ...projects.map((project) => (project.docker_image || project.github_url || "-").length),
  );
  const domainWidth = Math.max(6, ...projects.map((project) => (project.domain || "-").length));
  const header = [
    "NAME".padEnd(nameWidth),
    "STATUS".padEnd(statusWidth),
    "SOURCE".padEnd(sourceWidth),
    "DOMAIN".padEnd(domainWidth),
  ].join("  ");
  const rows = projects.map((project) =>
    [
      project.name.padEnd(nameWidth),
      project.status.padEnd(statusWidth),
      (project.docker_image || project.github_url || "-").padEnd(sourceWidth),
      (project.domain || "-").padEnd(domainWidth),
    ].join("  "),
  );
  return `${[header, "-".repeat(header.length), ...rows].join("\n")}\n`;
}
