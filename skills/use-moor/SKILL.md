---
name: use-moor
description: Operate an existing Moor server through the moor CLI to deploy, inspect, and troubleshoot projects. Use when asked to manage workloads on Moor, not to develop Moor or explain its architecture.
---

# Use Moor

Use the installed `moor` CLI to operate an existing Moor server. Do not use the Moor MCP server or call its HTTP API directly.

- Confirm `moor --version` works. The environment must already contain `MOOR_URL` and `MOOR_API_KEY`; never print the key or put it in command arguments.
- Use only command paths shown by `moor --help`, then inspect the relevant command's `--help`. Do not infer commands from MCP tool names.
- Use `--json` only when the command's help lists it; otherwise expect human-readable output. Check both the exit code and response. Finite JSON commands return one document on stdout; deploy and rebuild stream one `{ "event", "data" }` object per line.
- Retrieval success does not mean the workload is healthy. `exec` propagates the remote command's exit code; start/trigger/update acceptance does not mean execution completed. Inspect the returned state or ID. `job stop` and `run stop` can return `ok:false` on stdout with exit 1.
- Async job IDs belong to `job status/stop`; build and cron run IDs belong to `run get/stop`. Inspect server-update audit IDs with `server update audit`. Do not retry mutations blindly after a failed or lost response.
- Pass environment values through `--env-file -` on stdin, not through arguments.
- Mutate a server only when the user's request authorizes the change.

The installed CLI help defines the available capabilities. `moor logs --json --follow` is unsupported. If the requested capability is absent from the CLI help, report that gap instead of falling back to MCP, direct API calls, or guessed commands.
