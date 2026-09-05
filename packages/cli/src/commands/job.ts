import { readFile } from "node:fs/promises";
import { apiGet, apiPost, findProject } from "../client";
import { requestProjects } from "../project-response";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor job start <project> --file <path|-> [--json]
  moor job status <id> [--json]
  moor job stop <id> [--json]

Start reads a JSON object with command and optional timeout_ms; - reads stdin.
The API validates a shell command and timeout (60000–86400000 ms; default 24h).
Start returns run_id immediately; acceptance does not mean execution succeeded.
Job IDs are async execution IDs, NOT the IDs used by moor run or cron.
Status returns live output tails and state; exit 0 means retrieval succeeded.
Stop attempts cancellation once; inspect ok/state/message and do not retry blindly.
HTTP-success outcomes go to stdout; a stop outcome with ok:false exits 1.
Request errors go to stderr and exit 1. --json emits one document.`;

export async function jobCommand(
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
  if (verb !== "start" && verb !== "status" && verb !== "stop")
    return fail("Expected job start, status, or stop");
  let selector: string | undefined;
  let file: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--file" && verb === "start") {
      if (file !== undefined) return fail("--file may be used only once");
      const value = args[++index];
      if (!value || value.startsWith("--")) return fail("--file requires a value");
      file = value;
    } else if (arg.startsWith("-") || selector !== undefined)
      return fail("Unexpected argument; see --help");
    else selector = arg;
  }
  if (!selector?.trim())
    return fail(verb === "start" ? "Project is required" : "Job ID is required");
  let id = Number(selector);
  let body: unknown;
  if (verb === "start") {
    if (file === undefined) return fail("--file is required");
    let text: string;
    try {
      text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
    } catch {
      return fail("Unable to read job file");
    }
    try {
      body = JSON.parse(text);
    } catch {
      return fail("Job file must contain a JSON object");
    }
    if (!isRecord(body)) return fail("Job file must contain a JSON object");
    const projects = await requestProjects(json, output);
    if (!projects.ok) return 1;
    const project = findProject(projects.value, selector);
    if (!project) return fail(`Project "${selector}" not found`);
    id = project.id;
  } else if (!/^\d+$/.test(selector) || !Number.isSafeInteger(id) || id <= 0)
    return fail("Job ID must be a positive safe integer");
  const response = await requestJson<unknown>(
    () =>
      verb === "start"
        ? apiPost(`/api/projects/${id}/exec/async`, body)
        : verb === "status"
          ? apiGet(`/api/exec/${id}`)
          : apiPost(`/api/exec/${id}/stop`, {}),
    json,
    "Job request failed",
    output,
  );
  if (!response.ok) return 1;
  const value = response.value;
  if (
    verb === "start" &&
    (!isRecord(value) || !Number.isSafeInteger(value.run_id) || Number(value.run_id) <= 0)
  )
    return fail("Invalid job start response; request may have started a job, do not retry blindly");
  if (
    verb === "stop" &&
    (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.state !== "string")
  )
    return fail("Invalid job stop response; cancellation outcome is unknown");
  output.stdout(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
  return verb === "stop" && isRecord(value) && value.ok === false ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
