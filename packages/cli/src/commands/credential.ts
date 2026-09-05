import { readFile } from "node:fs/promises";
import type { SourceCredential, SourceCredentialCheckRequest } from "../../../contract/src/index";
import { apiGet, apiPost } from "../client";
import { type CommandOutput, defaultCommandOutput, requestJson, writeError } from "../protocol";

const USAGE = `Usage:
  moor credential source list [--json]
  moor credential source create --file <path|-> [--json]
  moor credential source check --github-url <url> [--branch <branch>] [--source-credential-id <id>] [--json]

Create reads a JSON object from disk or stdin (-); never pass secrets in argv.
Check tests repository access and may update the credential's stored state.
Finite JSON output goes to stdout; failures go to stderr and exit 1.`;
const ENDPOINT = "/api/server/source-credentials";

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
  if (kind !== "source" || !["list", "create", "check"].includes(verb ?? "")) {
    return fail("Use credential source list, create, or check; see --help");
  }
  const allowed =
    verb === "create"
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
  if (verb === "list") request = () => apiGet(ENDPOINT);
  else if (verb === "create") {
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
    request = () => apiPost(ENDPOINT, body);
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
    request = () => apiPost(`${ENDPOINT}/check`, body);
  }
  const result = await requestJson<unknown>(request, json, "Credential request failed", output);
  if (!result.ok) return 1;
  if (json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else {
    try {
      if (verb === "check") output.stdout(`${JSON.stringify(result.value, null, 2)}\n`);
      else {
        const rows =
          verb === "list"
            ? (result.value as { rows: SourceCredential[] }).rows
            : [result.value as SourceCredential];
        const lines = rows.map((row) => `${row.id}\t${row.hostname}\t${row.label}\t${row.state}`);
        output.stdout(`${lines.length ? lines.join("\n") : "No source credentials."}\n`);
      }
    } catch {
      return fail("Invalid credential response");
    }
  }
  return 0;
}
