---
name: use-moor
description: Operate an existing Moor server through the moor CLI to deploy, inspect, and troubleshoot projects. Use when asked to manage workloads on Moor, not to develop Moor or explain its architecture.
---

# Use Moor

Use the installed `moor` CLI to operate an existing Moor server. Do not use the Moor MCP server or call its HTTP API directly.

- Confirm `moor --version` works. The environment must already contain `MOOR_URL` and `MOOR_API_KEY`; never print the key or put it in command arguments.
- Use only command paths shown by `moor --help`, then inspect the relevant command's `--help`. Do not infer commands from MCP tool names.
- Use `--json` for agent-readable output and check the exit code. Finite commands return one JSON document on stdout. Deploy streams one `{ "event", "data" }` object per line. Failures are nonzero and write structured details to stderr.
- Pass deployment environment values through `--env-file -` on stdin, not through arguments.
- Mutate a server only when the user's request authorizes the change.

The initial supported surface is project listing, project inspection, project deployment, and finite logs. `moor logs --json --follow` is unsupported. If the requested capability is absent from the CLI help, report that gap instead of falling back to MCP, direct API calls, or guessed commands.
