import { apiGet } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor server update status [--json]
  moor server update audit [--limit N] [--json]

Read update readiness or recent update audit records without starting an update.
Audit limit is an integer from 1 to 200 (server default: 20).
Exit 0 means retrieval succeeded, even when unsafe to update or an audit records failure.
Inspect safe_to_update, unsafe_reasons, and audit state. No polling or retries.
Success prints one JSON document (formatted without --json); errors use stderr and exit 1.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nonnegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { current, available, active_work: work, db_backup: backup } = value;
  return (
    isRecord(current) &&
    typeof current.version === "string" &&
    typeof current.started_at === "string" &&
    nullableString(current.image_id) &&
    nullableString(current.repo_digest) &&
    isRecord(available) &&
    typeof available.latest_tag === "string" &&
    nullableString(available.latest_digest) &&
    nullableString(available.registry_error) &&
    (available.update_available === null || typeof available.update_available === "boolean") &&
    isRecord(work) &&
    ["builds_in_flight", "execs_in_flight", "crons_in_flight", "terminals_open"].every(
      (key) => Number.isSafeInteger(work[key]) && nonnegative(work[key]),
    ) &&
    isRecord(backup) &&
    nullableString(backup.last_backup_at) &&
    nullableString(backup.location) &&
    (backup.age_seconds === null || finite(backup.age_seconds)) &&
    typeof value.safe_to_update === "boolean" &&
    Array.isArray(value.unsafe_reasons) &&
    value.unsafe_reasons.every((reason: unknown) => typeof reason === "string") &&
    value.safe_to_update === (value.unsafe_reasons.length === 0) &&
    typeof value.recommended_command === "string"
  );
}

function isAudit(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row: unknown) =>
        isRecord(row) &&
        Number.isSafeInteger(row.id) &&
        (row.id as number) > 0 &&
        typeof row.started_at === "string" &&
        finite(row.started_at_ms) &&
        nullableString(row.finished_at) &&
        (row.finished_at_ms === null || finite(row.finished_at_ms)) &&
        (row.duration_ms === null || finite(row.duration_ms)) &&
        typeof row.state === "string" &&
        [
          "from_digest",
          "to_digest",
          "prev_image_id",
          "backup_path",
          "rollback_error",
          "error_log",
        ].every((key) => nullableString(row[key])),
    )
  );
}

export async function updateCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") i++;
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
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") continue;
    if (arg === "--limit") {
      if (limit !== undefined) return fail("--limit may be used only once");
      const raw = args[++i];
      const value = Number(raw);
      if (!raw?.trim() || !Number.isInteger(value) || value < 1 || value > 200) {
        return fail("--limit must be an integer from 1 to 200");
      }
      limit = value;
    } else if (arg.startsWith("-")) return fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const action = positional[0];
  if (positional.length !== 1 || (action !== "status" && action !== "audit")) {
    return fail("Expected update status or audit; see --help");
  }
  if (action === "status" && limit !== undefined) return fail("--limit is only supported by audit");
  const path =
    action === "status"
      ? "/api/server/update-status"
      : `/api/server/update/audit${limit === undefined ? "" : `?limit=${limit}`}`;
  const result = await requestJson<unknown>(
    () => apiGet(path),
    json,
    `Failed to get update ${action}`,
    output,
  );
  if (!result.ok) return 1;
  if (!(action === "status" ? isStatus(result.value) : isAudit(result.value))) {
    return fail(`Invalid update ${action} response`);
  }
  output.stdout(`${JSON.stringify(result.value, null, json ? undefined : 2)}\n`);
  return 0;
}
