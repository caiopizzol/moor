# @moor-sh/cli

Command-line interface for [moor](https://github.com/caiopizzol/moor) - manage your moor server's projects, logs, env vars, and container lifecycle from a terminal. Ships a `moor` binary.

Requires [Bun](https://bun.sh) on the machine running the CLI.

## Install

**One-shot** (no install):

```bash
bunx @moor-sh/cli status
```

**Global install** (puts `moor` on PATH):

```bash
bun add -g @moor-sh/cli
moor status
```

Don't use `bunx moor` (without the scope) - `moor` on npm is an unrelated package.

## Configure

```bash
export MOOR_URL=https://moor.example.com   # or http://127.0.0.1:8080 via SSH tunnel
export MOOR_API_KEY=your-api-key
```

`MOOR_API_KEY` grants admin-equivalent control of the moor host. See the [self-hosting guide](https://github.com/caiopizzol/moor/blob/main/docs/self-hosting.md#api-keys) for how to generate and rotate it.

For a remote moor with private admin (the default), open an SSH tunnel from your laptop before running CLI commands:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
export MOOR_URL=http://127.0.0.1:8080
```

## Commands

```
moor status                          # list all projects
moor logs <project> [-f] [-n 100]    # view container logs
moor rebuild <project>               # rebuild from source
moor restart <project>               # stop + start
moor exec <project> <command>        # run a command in the container
moor env list <project>              # list environment variables
moor env set <project> KEY=VALUE     # set environment variables and restart
moor stats                           # server resource usage
moor history <project> [--hours N]   # stored resource history and events
moor project deploy <name> [options] # create or update and optionally run a project
moor mcp config --client <name>      # generate MCP client config snippet
```

## `moor project deploy`

Deploy from GitHub or a registry image through the same API operation used by MCP:

```bash
moor project deploy api --github-url https://github.com/example/api
moor project deploy web --docker-image nginx:alpine --domain web.example.com --domain-port 80
moor project deploy private --github-url https://github.com/example/private --source-credential-id 42
```

Pass `--update-existing` to update a project with the same name, or `--no-run` to save its configuration without rebuilding or starting it. Environment values are read from a JSON object so secrets do not appear in the command line:

```bash
printf '%s' '{"DATABASE_URL":"..."}' | \
  moor project deploy api --github-url https://github.com/example/api --env-file -
```

Agents should pass `--json`. Each streamed API event is emitted as one JSON object per line:

```json
{"event":"deploy","data":{"action":"created","project_id":1,"project_name":"api","env_keys":[],"run":true,"env_changes_pending_restart":false}}
{"event":"done","data":"Container started"}
```

Failures return a non-zero exit status. Pre-stream errors are written to stderr and, in JSON mode, preserve the API's structured fields plus the HTTP `status`. Errors received after streaming begins remain ordered with the other JSONL events on stdout.

## `moor mcp config`

Generates a ready-to-paste config snippet for an MCP-compatible AI client. Removes the "open a doc, copy a JSON block, fill in the blanks" step from MCP setup.

```bash
moor mcp config --client claude        # or --client claude-code (alias)
moor mcp config --client codex
```

Output is JSON for `claude` / `claude-code` and TOML for `codex`. Prints to stdout - redirect or paste into `~/.claude.json` or `~/.codex/config.toml`. Optional flags: `--url <url>` (default `http://127.0.0.1:8080`), `--api-key <key>` (else read from `MOOR_API_KEY` env, then cwd `.env`, then a placeholder).

See [`@moor-sh/mcp`](https://www.npmjs.com/package/@moor-sh/mcp) for the MCP server itself.

## Links

- [moor repo](https://github.com/caiopizzol/moor) - main project, install instructions
- [Self-hosting guide](https://github.com/caiopizzol/moor/blob/main/docs/self-hosting.md) - first boot, API keys, admin domain, port model
- [`@moor-sh/mcp`](https://www.npmjs.com/package/@moor-sh/mcp) - MCP server for AI agent integration

## License

MIT.
