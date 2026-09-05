import { readFile } from "node:fs/promises";
import { apiGet, apiPost, apiPut, clientConfigError, findProject } from "../client";
import { requestProjects } from "../project-response";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor cron list <project> [--json]
  moor cron create <project> --file <path|-> [--json]
  moor cron update <id> --file <path|-> [--json]
  moor cron run <id> [--json]

Create/update read a JSON object; - reads stdin. The API validates fields.
Create requires name, schedule and command; optional timeout_ms and enabled.
Jobs are enabled by default. Use enabled:false to create a disabled job.
Schedules use server-local time; commands run through the container's shell.
Update can change those fields or enabled. It does not trigger a run.
Run triggers once, even if disabled, and returns run_id without waiting.
Inspect that ID with moor run get, not moor job status. Do not retry blindly.
Exit 0 means the request succeeded, not that a scheduled job succeeded.
Inspect results with moor run list/get. --json emits one document.`;

export async function cronCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const fail = (message: string) => {
    writeError(output, message, json);
    return 1;
  };
  const verb = args[0];
  if (verb !== "list" && verb !== "create" && verb !== "update" && verb !== "run")
    return fail("Expected cron list, create, update, or run");
  const byId = verb === "update" || verb === "run";
  let selector: string | undefined;
  let file: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--file" && (verb === "create" || verb === "update")) {
      if (file !== undefined) return fail("--file may be used only once");
      const value = args[++index];
      if (!value || value.startsWith("--")) return fail("--file requires a value");
      file = value;
    } else if (arg.startsWith("-") || selector !== undefined)
      return fail("Unexpected argument; see --help");
    else selector = arg;
  }
  if (!selector?.trim()) return fail(byId ? "Cron ID is required" : "Project is required");
  let id = Number(selector);
  if (byId && (!/^\d+$/.test(selector) || !Number.isSafeInteger(id) || id <= 0))
    return fail("Cron ID must be a positive safe integer");
  let body: unknown;
  if ((verb === "create" || verb === "update") && file === undefined)
    return fail("--file is required");
  const configError = clientConfigError();
  if (configError) return fail(configError);
  if (!byId) {
    const projects = await requestProjects(json, output);
    if (!projects.ok) return 1;
    const project = findProject(projects.value, selector);
    if (!project) return fail(`Project "${selector}" not found`);
    id = project.id;
  }
  if (file !== undefined) {
    let text: string;
    try {
      text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
    } catch {
      return fail("Unable to read cron file");
    }
    try {
      body = JSON.parse(text);
    } catch {
      return fail("Cron file must contain a JSON object");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail("Cron file must contain a JSON object");
  }
  const response = await requestJson<unknown>(
    () =>
      verb === "run"
        ? apiPost(`/api/crons/${id}/run`, {})
        : verb === "update"
          ? apiPut(`/api/crons/${id}`, body)
          : verb === "create"
            ? apiPost(`/api/projects/${id}/crons`, body)
            : apiGet(`/api/projects/${id}/crons`),
    json,
    "Cron request failed",
    output,
  );
  if (!response.ok) return 1;
  if (verb === "run") {
    const value = response.value;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("ok" in value) ||
      value.ok !== true ||
      !("run_id" in value) ||
      !Number.isSafeInteger(value.run_id) ||
      Number(value.run_id) <= 0
    )
      return fail(
        "Invalid cron run response; request may have started a run, do not retry blindly",
      );
  }
  output.stdout(`${JSON.stringify(response.value, null, json ? undefined : 2)}\n`);
  return 0;
}
