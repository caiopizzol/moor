import { readFile } from "node:fs/promises";
import type { SourceCredentialCheckRequest } from "../../../contract/src/index";
import { apiGet, apiPost, apiPut } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor credential source list [--json]
  moor credential source create --file <path|-> [--json]
  moor credential source update --source-credential-id <id> --file <path|-> [--json]
  moor credential source check --github-url <url> [--branch <branch>] [--source-credential-id <id>] [--json]
  moor credential registry list [--json]
  moor credential registry create --file <path|-> [--json]
  moor credential registry update --registry-credential-id <id> --file <path|-> [--json]

Create/update read a JSON object from disk or stdin (-); never pass secrets in argv.
Update stores a patch without checking access or changing credential state.
Source check tests repository access and may update the credential's stored state.
Registry storage does not test authentication or pull images; there is no registry check command.
Finite JSON output goes to stdout; failures go to stderr and exit 1.`;

export async function credentialCommand(
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
  const [kind, verb] = args;
  if (
    (kind !== "source" && kind !== "registry") ||
    !["list", "create", "update", ...(kind === "source" ? ["check"] : [])].includes(verb ?? "")
  ) {
    return fail("Unsupported credential command; see --help");
  }
  const endpoint = `/api/server/${kind}-credentials`;
  const idOption = `--${kind}-credential-id`;
  const allowed =
    verb === "update"
      ? ["--file", idOption]
      : verb === "create"
        ? ["--file"]
        : verb === "check"
          ? ["--github-url", "--branch", "--source-credential-id"]
          : [];
  const options = new Map<string, string>();
  for (let index = 2; index < args.length; index++) {
    const option = args[index];
    if (option === "--json") continue;
    if (!allowed.includes(option)) return fail("Unexpected argument; see --help");
    if (options.has(option)) return fail(`${option} may be used only once`);
    const value = args[++index];
    if (!value || value.startsWith("--")) return fail(`${option} requires a value`);
    options.set(option, value);
  }

  let request: () => Promise<Response>;
  if (verb === "list") request = () => apiGet(endpoint);
  else if (verb === "create" || verb === "update") {
    let id: number | undefined;
    if (verb === "update") {
      const value = options.get(idOption);
      if (value === undefined) return fail(`${idOption} is required`);
      id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return fail(`${idOption} must be a positive integer`);
      }
    }
    const file = options.get("--file");
    if (!file) return fail("--file is required");
    let text: string;
    try {
      text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
    } catch {
      return fail("Unable to read credential file");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail("Credential file must contain a JSON object");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return fail("Credential file must contain a JSON object");
    }
    request =
      verb === "update" ? () => apiPut(`${endpoint}/${id}`, body) : () => apiPost(endpoint, body);
  } else {
    const url = options.get("--github-url");
    if (!url?.trim()) return fail("--github-url is required");
    const body: SourceCredentialCheckRequest = { github_url: url };
    const branch = options.get("--branch");
    if (branch !== undefined) {
      if (!branch.trim()) return fail("--branch must not be blank");
      body.branch = branch;
    }
    const id = options.get("--source-credential-id");
    if (id !== undefined) {
      const number = Number(id);
      if (!Number.isSafeInteger(number) || number <= 0) {
        return fail("--source-credential-id must be a positive integer");
      }
      body.source_credential_id = number;
    }
    request = () => apiPost(`${endpoint}/check`, body);
  }
  const result = await requestJson<unknown>(request, json, "Credential request failed", output);
  if (!result.ok) return 1;
  if (json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else {
    try {
      if (verb === "check") output.stdout(`${JSON.stringify(result.value, null, 2)}\n`);
      else {
        const rows = verb === "list" ? (result.value as { rows: unknown }).rows : [result.value];
        if (!Array.isArray(rows)) return fail("Invalid credential response");
        const lines = rows.map((row) => renderCredential(row, kind));
        output.stdout(`${lines.length ? lines.join("\n") : `No ${kind} credentials.`}\n`);
      }
    } catch {
      return fail("Invalid credential response");
    }
  }
  return 0;
}

function renderCredential(value: unknown, kind: "source" | "registry"): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid credential response");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    typeof row.hostname !== "string" ||
    !row.hostname.trim()
  ) {
    throw new Error("Invalid credential response");
  }
  if (kind === "registry") {
    if (typeof row.username !== "string" || !row.username.trim()) {
      throw new Error("Invalid credential response");
    }
    return `${row.id}\t${row.hostname}\t${row.username}`;
  }
  if (
    typeof row.label !== "string" ||
    !row.label.trim() ||
    (row.state !== "active" && row.state !== "failed")
  ) {
    throw new Error("Invalid credential response");
  }
  return `${row.id}\t${row.hostname}\t${row.label}\t${row.state}`;
}
