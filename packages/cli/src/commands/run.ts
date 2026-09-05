import type { Project } from "../../../contract/src/index";
import { apiGet, findProject } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

export const RUN_USAGE = `Usage:
  moor run list <project> [--page N] [--json]
  moor run get <id> [--tail-bytes N] [--json]

List returns 20 run summaries per page without output bodies (default page 1).
Get returns metadata and the last 8192 bytes per stream (0–65536 with --tail-bytes).
Output may already be truncated on the server; total byte counts are preserved.
Exit 0 means retrieval succeeded, even when the recorded run failed.`;

type RunRecord = Record<string, unknown> & { id: number };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRun(value: unknown): value is RunRecord {
  return isRecord(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0;
}

function tail(value: string, cap: number): string {
  const bytes = new TextEncoder().encode(value);
  let start = Math.max(0, bytes.length - cap);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

export async function runCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${RUN_USAGE}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const fail = (message: string) => {
    writeError(output, message, json);
    return 1;
  };
  const action = args[0];
  if (action !== "list" && action !== "get") return fail("Expected run list or run get");
  const option = action === "list" ? "--page" : "--tail-bytes";
  let amount = action === "list" ? 1 : 8192;
  let selector: string | undefined;
  let seenOption = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === option) {
      if (seenOption) return fail(`Duplicate option: ${option}`);
      seenOption = true;
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) return fail(`${option} requires a value`);
      amount = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(amount) ||
        amount < (action === "list" ? 1 : 0) ||
        amount > (action === "list" ? Math.floor(Number.MAX_SAFE_INTEGER / 20) : 65536)
      ) {
        return fail(
          action === "list"
            ? "--page must be a positive safe page number"
            : "--tail-bytes must be an integer from 0 to 65536",
        );
      }
    } else if (arg.startsWith("-")) return fail(`Unknown option: ${arg}`);
    else if (selector !== undefined) return fail(`Unexpected argument: ${arg}`);
    else selector = arg;
  }
  if (!selector) return fail(action === "list" ? "Project is required" : "Run ID is required");
  let path: string;
  if (action === "list") {
    const projects = await requestJson<Project[]>(
      () => apiGet("/api/projects"),
      json,
      "Failed to list projects",
      output,
    );
    if (!projects.ok) return 1;
    if (
      !Array.isArray(projects.value) ||
      projects.value.some(
        (p) => !p || !Number.isSafeInteger(p.id) || p.id <= 0 || typeof p.name !== "string",
      )
    )
      return fail("Invalid project response");
    const project = findProject(projects.value, selector);
    if (!project) return fail(`Project "${selector}" not found`);
    path = `/api/projects/${project.id}/runs?include_output=false&page=${amount}`;
  } else {
    const id = Number(selector);
    if (!/^\d+$/.test(selector) || !Number.isSafeInteger(id) || id <= 0)
      return fail("Run ID must be a positive safe integer");
    path = `/api/runs/${id}`;
  }
  const response = await requestJson<unknown>(
    () => apiGet(path),
    json,
    "Failed to get runs",
    output,
  );
  if (!response.ok) return 1;
  const value = response.value;
  if (action === "list") {
    if (
      !isRecord(value) ||
      !Array.isArray(value.runs) ||
      !value.runs.every(isRun) ||
      !Number.isSafeInteger(value.total) ||
      Number(value.total) < 0
    )
      return fail("Invalid run list response");
    if (json) output.stdout(`${JSON.stringify(value)}\n`);
    else {
      output.stdout(`${value.runs.length} run(s) on page ${amount}, ${value.total} total\n`);
      for (const run of value.runs)
        output.stdout(
          `id=${run.id} exit=${run.exit_code ?? "-"} started=${run.started_at ?? "-"} finished=${run.finished_at ?? "-"}\n`,
        );
    }
  } else {
    if (
      !isRun(value) ||
      !(value.stdout === null || typeof value.stdout === "string") ||
      !(value.stderr === null || typeof value.stderr === "string")
    )
      return fail("Invalid run response");
    const result = { ...value };
    for (const stream of ["stdout", "stderr"] as const) {
      const stored = value[stream] as string | null;
      const size = new TextEncoder().encode(stored ?? "").length;
      const total = value[`${stream}_total_bytes`];
      result[`${stream}_total_bytes`] = total ?? size;
      result[stream] = stored === null ? null : tail(stored, amount);
      result[`${stream}_truncated`] =
        size > new TextEncoder().encode((result[stream] as string) ?? "").length ||
        (typeof total === "number" && total > size);
    }
    output.stdout(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);
  }
  return 0;
}
