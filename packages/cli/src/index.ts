#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envCommand } from "./commands/env";
import { execCommand } from "./commands/exec";
import { logsCommand } from "./commands/logs";
import { rebuildCommand } from "./commands/rebuild";
import { restartCommand } from "./commands/restart";
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
  status                          List all projects
  logs <project> [-f] [-n <lines>] View container logs
  rebuild <project> [--no-cache]  Rebuild and restart from source
  restart <project>               Stop and start a container
  exec <project> <command>        Run a command in a container
  env list <project>              List environment variables
  env set <project> K=V [K=V ...] Set environment variables
  stats                           Show server resource usage

Environment:
  MOOR_URL      Server URL (e.g. https://moor.example.com)
  MOOR_API_KEY  API key for authentication`);
}

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "status":
    await statusCommand();
    break;
  case "logs":
    await logsCommand(args.slice(1));
    break;
  case "rebuild":
    await rebuildCommand(args.slice(1));
    break;
  case "restart":
    await restartCommand(args.slice(1));
    break;
  case "exec":
    await execCommand(args.slice(1));
    break;
  case "env":
    await envCommand(args.slice(1));
    break;
  case "stats":
    await statsCommand();
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
