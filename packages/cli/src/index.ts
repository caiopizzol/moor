#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deployCommand } from "./commands/deploy";
import { envCommand } from "./commands/env";
import { execCommand } from "./commands/exec";
import { historyCommand } from "./commands/history";
import { logsCommand } from "./commands/logs";
import { mcpCommand } from "./commands/mcp";
import { PROJECT_USAGE, projectGetCommand, projectListCommand } from "./commands/project";
import { rebuildCommand } from "./commands/rebuild";
import { restartCommand } from "./commands/restart";
import { runCommand } from "./commands/run";
import { statsCommand } from "./commands/stats";
import { statusCommand } from "./commands/status";

// Read version from package.json at runtime so the binary always reports the
// real shipped version. import.meta.dir resolves to packages/cli/src in this
// repo and to <install-root>/src in a published install; ../package.json is
// the package root in both cases.
const VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

function printHelp() {
  console.log(`moor - CLI for Moor server management

Usage: moor <command> [options]

Commands:
  status                          List all projects (human-readable alias)
  logs <project> [-f] [-n <lines>] [--json] View container logs
  rebuild <project> [--no-cache] [--json] Rebuild and restart from source
  restart <project> [--json]      Stop and start a container
  exec <project> [--json] -- <command> Run a shell command in a container
  env list <project> [--json]     List environment variables
  env set <project> [options]     Set environment variables
  env delete <project> <keys...> [--json] Remove environment variables
  stats                           Show server resource usage
  history <project> [--hours N]   Stored resource history + events (default 24h)
  run list <project> [--page N] [--json] List run summaries
  run get <id> [--tail-bytes N] [--json] Inspect a run and its stored output
  project list [--json]           List projects
  project get <name|id> [--json]  Get one project
  project deploy <name> [options] Create or update and optionally run a project
  mcp config --client <name>      Generate MCP client config snippet

Environment:
  MOOR_URL      Server URL (e.g. https://moor.example.com)
  MOOR_API_KEY  API key for authentication`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "status":
    process.exitCode = await statusCommand(args.slice(1));
    break;
  case "logs":
    process.exitCode = await logsCommand(args.slice(1));
    break;
  case "rebuild":
    process.exitCode = await rebuildCommand(args.slice(1));
    break;
  case "restart":
    process.exitCode = await restartCommand(args.slice(1));
    break;
  case "exec":
    process.exitCode = await execCommand(args.slice(1));
    break;
  case "env":
    process.exitCode = await envCommand(args.slice(1));
    break;
  case "stats":
    await statsCommand();
    break;
  case "history":
    await historyCommand(args.slice(1));
    break;
  case "run":
    process.exitCode = await runCommand(args.slice(1));
    break;
  case "project":
    if (args[1] === "list") process.exitCode = await projectListCommand(args.slice(2));
    else if (args[1] === "get") process.exitCode = await projectGetCommand(args.slice(2));
    else if (args[1] === "deploy") process.exitCode = await deployCommand(args.slice(2));
    else if (args[1] === "--help" || args[1] === "-h") console.log(PROJECT_USAGE);
    else {
      console.error(PROJECT_USAGE);
      process.exitCode = 1;
    }
    break;
  case "mcp":
    mcpCommand(args.slice(1));
    break;
  case "--help":
  case "-h":
  case "help":
    printHelp();
    break;
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  default:
    if (command) console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exit(command ? 1 : 0);
}
