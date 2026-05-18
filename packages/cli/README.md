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
moor mcp config --client <name>      # generate MCP client config snippet
```

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
