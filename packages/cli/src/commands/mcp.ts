import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Client = "claude" | "codex";

const CLIENT_ALIASES: Record<string, Client> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
};

const DEFAULT_URL = "http://127.0.0.1:8080";
const PLACEHOLDER_KEY = "<your-api-key>";

/** Parse cwd's .env conservatively. Skips blank/comment lines, strips one
 *  matching pair of surrounding quotes, does not interpolate or expand. */
function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveApiKey(flagValue: string | undefined): string {
  if (flagValue) return flagValue;
  if (process.env.MOOR_API_KEY) return process.env.MOOR_API_KEY;
  const dotenv = parseDotEnv(join(process.cwd(), ".env"));
  if (dotenv.MOOR_API_KEY) return dotenv.MOOR_API_KEY;
  return PLACEHOLDER_KEY;
}

function configFor(client: Client, url: string, apiKey: string): string {
  if (client === "claude") {
    return JSON.stringify(
      {
        mcpServers: {
          moor: {
            command: "bunx",
            args: ["@moor-sh/mcp"],
            env: { MOOR_URL: url, MOOR_API_KEY: apiKey },
          },
        },
      },
      null,
      2,
    );
  }
  // codex TOML. TOML basic-string escape rules (" and \) are a subset of
  // JSON's, so JSON.stringify produces a valid quoted TOML string for any
  // value - including URLs/keys that contain quotes or backslashes.
  return [
    "[mcp_servers.moor]",
    'command = "bunx"',
    'args = ["@moor-sh/mcp"]',
    "",
    "[mcp_servers.moor.env]",
    `MOOR_URL = ${JSON.stringify(url)}`,
    `MOOR_API_KEY = ${JSON.stringify(apiKey)}`,
  ].join("\n");
}

function parseFlags(args: string[]): { client?: string; url?: string; apiKey?: string } {
  const flags: { client?: string; url?: string; apiKey?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--client" && i + 1 < args.length) flags.client = args[++i];
    else if (a === "--url" && i + 1 < args.length) flags.url = args[++i];
    else if (a === "--api-key" && i + 1 < args.length) flags.apiKey = args[++i];
  }
  return flags;
}

function printHelp() {
  console.log(`moor mcp config - Generate MCP client config snippet for moor

Usage: moor mcp config --client <name> [--url <url>] [--api-key <key>]

Required:
  --client <name>     One of: claude, claude-code, codex

Optional:
  --url <url>         moor URL the MCP server should reach (default: ${DEFAULT_URL})
  --api-key <key>     bearer token. Falls back to MOOR_API_KEY env, then
                      cwd's .env, then a placeholder.

Output is printed to stdout for you to paste into your client's config file:
  Claude Code:  ~/.claude.json
  Codex:        ~/.codex/config.toml`);
}

export function mcpCommand(args: string[]) {
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help" || !subcommand) {
    printHelp();
    return;
  }

  if (subcommand !== "config") {
    console.error(`Unknown mcp subcommand: ${subcommand}\n`);
    printHelp();
    process.exit(1);
  }

  const flags = parseFlags(args.slice(1));
  if (!flags.client) {
    console.error("moor mcp config requires --client <claude|claude-code|codex>\n");
    printHelp();
    process.exit(1);
  }
  const client = CLIENT_ALIASES[flags.client];
  if (!client) {
    console.error(`Unknown client: ${flags.client}. Expected one of: claude, claude-code, codex`);
    process.exit(1);
  }

  const url = flags.url || DEFAULT_URL;
  const apiKey = resolveApiKey(flags.apiKey);
  console.log(configFor(client, url, apiKey));
}
