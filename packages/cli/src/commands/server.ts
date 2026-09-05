import { apiGet, apiPost } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";
import { cleanupCommand } from "./cleanup";
import { updateCommand } from "./update";

const USAGE = `Usage:
  moor server update <status|audit> [options] (see update --help)
  moor server cleanup <plan|execute> [options] (see cleanup --help)
  moor server backup [--json]
  moor server drain status [--json]
  moor server drain enable [--reason <text>] [--ttl-minutes N] [--json]
  moor server drain disable [--json]

Drain refuses new work; it does not kill existing work. Status includes active-work counts.
TTL must be finite and positive. The server defaults to 30 minutes and clamps to 0.05–10080.
Enabling again replaces the reason and resets expiry. Disabling does not restart work.
Backup creates a server-local SQLite snapshot and prunes older snapshots (keeps seven).
It does not back up volumes, download files, or provide an offsite backup. No automatic retries.
Success emits one JSON document with --json (formatted JSON otherwise); failures use stderr and exit 1.
`;

export async function serverCommand(
  args: string[],
  output: CommandOutput = defaultCommandOutput,
): Promise<number> {
  const groupIndex = args.findIndex((arg) => arg !== "--json");
  if (args[groupIndex] === "update") {
    return updateCommand(
      args.filter((_, index) => index !== groupIndex),
      output,
    );
  }
  if (args[groupIndex] === "cleanup") {
    return cleanupCommand(
      args.filter((_, index) => index !== groupIndex),
      output,
    );
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reason" || args[i] === "--ttl-minutes") {
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      output.stdout(USAGE);
      return 0;
    }
  }
  const json = args.includes("--json");
  const positional: string[] = [];
  const input: { reason?: string; ttl_minutes?: number } = {};
  const seen = new Set<string>();
  const fail = (message: string) => {
    writeError(output, message, json);
    return 1;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") continue;
    if (arg === "--reason" || arg === "--ttl-minutes") {
      if (seen.has(arg)) return fail(`Duplicate option: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return fail(`Missing value for ${arg}`);
      if (arg === "--reason") input.reason = value;
      else {
        const ttl = Number(value);
        if (!value.trim() || !Number.isFinite(ttl) || ttl <= 0) {
          return fail("--ttl-minutes must be a finite positive number");
        }
        input.ttl_minutes = ttl;
      }
    } else if (arg.startsWith("-")) return fail(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [group, action] = positional;
  if (group === "backup") {
    if (positional.length !== 1 || seen.size > 0) {
      return fail("Usage: moor server backup [--json]");
    }
    const result = await requestJson<unknown>(
      () => apiPost("/api/server/backup", {}),
      json,
      "Failed to back up database",
      output,
    );
    if (!result.ok) return 1;
    if (!isBackupResult(result.value)) {
      return fail("Invalid backup response; outcome unknown. Inspect the server before retrying.");
    }
    output.stdout(`${JSON.stringify(result.value, null, json ? undefined : 2)}\n`);
    return 0;
  }
  if (
    positional.length !== 2 ||
    group !== "drain" ||
    (action !== "status" && action !== "enable" && action !== "disable")
  ) {
    return fail("Expected server backup or server drain status, enable, or disable; see --help");
  }
  if (action !== "enable" && seen.size > 0) {
    return fail("--reason and --ttl-minutes are only supported by drain enable");
  }
  const result = await requestJson<unknown>(
    () =>
      action === "status"
        ? apiGet("/api/server/drain")
        : apiPost(`/api/server/drain/${action}`, input),
    json,
    action === "status" ? "Failed to get drain status" : `Failed to ${action} drain`,
    output,
  );
  if (!result.ok) return 1;
  output.stdout(`${JSON.stringify(result.value, null, json ? undefined : 2)}\n`);
  return 0;
}

function isBackupResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.path === "string" &&
    fields.path.trim().length > 0 &&
    typeof fields.sizeBytes === "number" &&
    Number.isFinite(fields.sizeBytes) &&
    fields.sizeBytes >= 0 &&
    typeof fields.durationMs === "number" &&
    Number.isFinite(fields.durationMs) &&
    fields.durationMs >= 0
  );
}
