---
name: use-moor
description: Operate an existing Moor server through the moor CLI to deploy, inspect, and troubleshoot projects. Use when asked to manage workloads on Moor, not to develop Moor or explain its architecture.
---

# Use Moor

Use the installed `moor` CLI to operate an existing Moor server. Do not use the Moor MCP server or call its HTTP API directly.

- Confirm `moor --version` works. The environment must already contain `MOOR_URL` and `MOOR_API_KEY`; never print the key or put it in command arguments.
- Use only command paths shown by `moor --help`, then inspect the relevant command's `--help`. Do not infer commands from MCP tool names.
- Use `--json` only when the command's help lists it; otherwise expect human-readable output. Always check the exit code. Finite JSON commands return one document on stdout. Deploy streams one `{ "event", "data" }` object per line.
- Pass environment values through `--env-file -` on stdin, not through arguments.
- Mutate a server only when the user's request authorizes the change.

The supported agent surface is project listing, project inspection, project deployment, secure environment updates, and finite logs. `moor logs --json --follow` is unsupported. If the requested capability is absent from the CLI help, report that gap instead of falling back to MCP, direct API calls, or guessed commands.
