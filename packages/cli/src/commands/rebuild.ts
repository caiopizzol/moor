import type { Project } from "../../../contract/src/index";
import { apiGet, apiPost, findProject, streamSSE } from "../client";
import {
  type CommandOutput,
  defaultCommandOutput,
  formatResponseError,
  requestJson,
  writeError,
} from "../protocol";

const USAGE = `Usage: moor rebuild <project> [--no-cache] [--json]

Options:
  --no-cache  Rebuild without the Docker build cache
  --json      Emit one {event,data} JSON object per line`;

export async function rebuildCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const noCache = args.includes("--no-cache");
  const positional = args.filter((arg) => arg !== "--json" && arg !== "--no-cache");
  const option = positional.find((arg) => arg.startsWith("-"));
  const selector = positional[0];
  const error = option
    ? `Unknown option: ${option}`
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
  const query = noCache ? "?nocache=true" : "";
  if (!json) output.stdout(`Rebuilding ${project.name}...\n`);
  let response: Response;
  try {
    response = await apiPost(`/api/projects/${project.id}/run${query}`);
  } catch (error) {
    writeError(output, error instanceof Error ? error.message : String(error), json);
    return 1;
  }
  if (!response.ok) {
    output.stderr(`${await formatResponseError(response, json, "Failed to rebuild")}\n`);
    return 1;
  }

  let failed = false;
  let done = false;
  let structuredError = false;
  const streamError = (message: string) => {
    if (json) output.stdout(`${JSON.stringify({ event: "error", data: message })}\n`);
    else writeError(output, message, false);
  };
  try {
    await streamSSE(response, {
      onEvent: ({ event, data }) => {
        if (event === "done") done = true;
        if (event === "error" || event === "structured-error") failed = true;
        if (json) {
          output.stdout(`${JSON.stringify({ event, data })}\n`);
        } else if (event === "log" && typeof data === "string") output.stdout(data);
        else if (event === "done" && typeof data === "string") output.stdout(`${data}\n`);
        else if (event === "structured-error") {
          const detail = data as { code?: unknown; message?: unknown } | null;
          if (typeof detail?.code === "string" && typeof detail.message === "string") {
            output.stderr(`Error [${detail.code}]: ${detail.message}\n`);
            structuredError = true;
          } else streamError("Rebuild failed");
        } else if (event === "error" && !structuredError) {
          streamError(typeof data === "string" ? data : "Rebuild failed");
        }
      },
    });
  } catch (error) {
    streamError(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!done && !failed) {
    streamError("Rebuild stream ended before completion");
    return 1;
  }
  return failed ? 1 : 0;
}
