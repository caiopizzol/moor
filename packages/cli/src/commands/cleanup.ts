import { readFile } from "node:fs/promises";
import { apiPost, clientConfigError } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor server cleanup plan [--json]
  moor server cleanup execute --file <path|-> [--json]

Plan inspects build cache and dangling images without deleting anything.
Review the plan and keep only selected candidates in the JSON file before execute.
Execute irreversibly removes selected resources; it does not remove volumes or containers.
Build-cache cleanup prunes currently unused cache, not a fixed set or byte limit.
Dangling images are rechecked by ID; no force or parent-image pruning is used.
Use --file - for stdin. No automatic planning, retries, or polling.
JSON success/partial results go to stdout; partial failures exit 1. Request errors use stderr.
A failed request may follow partial deletion. Inspect the server before retrying.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export async function cleanupCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") i++;
    else if (args[i] === "--help" || args[i] === "-h") {
      output.stdout(USAGE);
      return 0;
    }
  }
  const json = args.includes("--json");
  const fail = (message: string) => {
    writeError(output, message, json);
    return 1;
  };
  const positional: string[] = [];
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") continue;
    if (arg === "--file") {
      if (file !== undefined) return fail("--file may be used only once");
      const value = args[++i];
      if (!value || value.startsWith("--")) return fail("--file requires a value");
      file = value;
    } else if (arg.startsWith("-")) return fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const verb = positional[0];
  if (positional.length !== 1 || (verb !== "plan" && verb !== "execute")) {
    return fail("Expected cleanup plan or execute; see --help");
  }
  if (verb === "plan" && file !== undefined) return fail("--file is only supported by execute");
  if (verb === "execute" && file === undefined) return fail("--file is required");
  const configError = clientConfigError();
  if (configError) return fail(configError);

  let body: Record<string, unknown> = {};
  let candidates: Record<string, unknown>[] = [];
  if (file !== undefined) {
    let text: string;
    try {
      text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
    } catch {
      return fail("Unable to read cleanup file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("Cleanup file must contain a JSON object with a nonempty candidates array");
    }
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.candidates) ||
      parsed.candidates.length === 0 ||
      !parsed.candidates.every(isRecord)
    ) {
      return fail("Cleanup file must contain a JSON object with a nonempty candidates array");
    }
    body = parsed;
    candidates = parsed.candidates;
  }
  const response = await requestJson<unknown>(
    () => apiPost(`/api/server/cleanup/${verb}`, body),
    json,
    `Failed to ${verb} cleanup`,
    output,
  );
  if (!response.ok) return 1;
  const value = response.value;
  if (verb === "plan") {
    if (
      !isRecord(value) ||
      !Array.isArray(value.candidates) ||
      !value.candidates.every(isRecord) ||
      !isBytes(value.total_reclaimable_bytes)
    )
      return fail("Invalid cleanup plan response");
    output.stdout(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
    return 0;
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.audit_id) ||
    (value.audit_id as number) <= 0 ||
    !isBytes(value.total_reclaimed_bytes) ||
    !Array.isArray(value.results) ||
    value.results.length !== candidates.length ||
    !value.results.every((result: unknown, i: number) => {
      const candidate = candidates[i];
      return (
        isRecord(result) &&
        candidate !== undefined &&
        (result.category === "build_cache" || result.category === "dangling_image") &&
        result.category === candidate.category &&
        (result.category !== "dangling_image" ||
          (typeof result.id === "string" && result.id === candidate.id)) &&
        isBytes(result.reclaimed_bytes) &&
        (result.error === null || typeof result.error === "string")
      );
    })
  ) {
    return fail(
      "Invalid cleanup execute response; outcome unknown. Partial deletion may have occurred. Inspect the server before retrying.",
    );
  }
  output.stdout(`${JSON.stringify(value, null, json ? undefined : 2)}\n`);
  return value.results.some((result: Record<string, unknown>) => result.error !== null) ? 1 : 0;
}
