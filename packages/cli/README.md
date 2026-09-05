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
moor status                          # list all projects (human-readable alias)
moor project list [--json]           # list projects
moor project get <name|id> [--json]  # get one project
moor logs <project> [-f] [-n 100] [--json] # view container logs
moor rebuild <project> [--no-cache] [--json] # rebuild from source
moor restart <project> [--json]      # stop + start
moor stop <project> [--json]         # stop without deleting the project
moor exec <project> [--json] -- <command> # run a shell command in the container
moor env list <project> [--json]     # list environment variables
moor env set <project> KEY=VALUE     # set environment variables (human mode)
moor env set <project> --env-file - --json # set environment variables (agent mode)
moor stats [--json]                  # server resource usage
moor history <project> [--hours N] [--json] # stored resource history and events
moor project deploy <name> [options] # create or update and optionally run a project
moor mcp config --client <name>      # generate MCP client config snippet
```

## Project inspection

Use the project commands to verify a deploy or inspect current configuration:

```bash
moor project list --json
moor project get api --json
moor project get 7 --json
```

Both commands print one JSON document to stdout in `--json` mode. Failures print a JSON error to stderr and exit nonzero. Without `--json`, `project list` uses the same table as the existing `moor status` alias and `project get` prints readable, indented JSON.

Project selectors accept a name or numeric ID. If a numeric selector matches both, an exact project name takes precedence.

## Logs

Use finite JSON mode when an agent needs recent container output and its state:

```bash
moor logs api -n 100 --json
```

Success prints the API response as one JSON document with `logs`, `lastTimestamp`, and `state` (`ok`, `exited`, `no_container`, or `missing`). Failures print structured JSON to stderr and exit nonzero. Exact project names take precedence over numeric IDs, matching `moor project get`.

`--json` cannot be combined with `--follow` yet. Use `moor logs api --follow` for the existing human-readable polling mode; a later streaming slice will define JSONL follow events.

## Host stats

`moor stats --json` returns the server's stats response as one JSON document, including host CPU, memory, disk, and container totals. Without `--json`, it retains the human-readable summary. Errors go to stderr and exit 1; unknown options and extra arguments are rejected before any request.

## Resource history

`moor history api --hours 6 --json` returns the full API history document, including stored samples, events, and summary. The default window is 24 hours; `--hours=N` and fractional hours also work. Windows extending before the Unix epoch start at zero. Human mode retains the summary and ten most recent events.

Errors go to stderr and exit 1. Unknown arguments, duplicate `--hours`, and invalid durations are rejected before requests. Exit 0 means history was retrieved, not that the workload is healthy.

## Run inspection

`moor run list api --page 1 --json` returns `{runs,total}` with 20 summaries per page and no stdout/stderr bodies. `moor run get 11 --json` returns the run metadata and the last 8192 bytes of each output stream. Use `--tail-bytes 0` for metadata only, or up to 65536 bytes per stream.

Detail output includes `stdout_truncated` and `stderr_truncated` flags and preserves total byte counts. UTF-8 characters are not split. The CLI limits displayed output after fetching the stored run; it does not limit the API download. Server-side retention may already have removed older output.

Exit 0 means the read succeeded, even if the recorded run has a nonzero `exit_code`. Argument and request failures exit 1 and put errors on stderr. Without `--json`, list shows summary lines and get shows indented JSON. These commands do not stop or retry runs.

## Exec

`moor exec api --json -- 'printf hello'` prints one JSON document with `exitCode`, `stdout`, and `stderr`. The CLI exits with the container command's exit code, including nonzero results. Request and argument failures instead print a JSON error to stderr and exit 1.

Put Moor options before `--`; everything after it belongs to the container command. Arguments are joined with spaces into a shell command, not passed as an argv array. Quote shell expressions to prevent your local shell from expanding them. Do not put secrets in command arguments.

Existing human calls such as `moor exec api ls -la` still work and print the container's stdout and stderr directly. One compatibility exception: a standalone `--json` token anywhere without a separator is rejected to avoid confusing Moor output options with remote options. For a remote JSON option, use `moor exec api -- gh pr list --json state`; Moor still prints human-mode output. This command runs synchronously; asynchronous exec is not included in this slice.

## Restart

`moor restart api --json` returns the API response as one JSON document. Errors go to stderr with a non-zero exit code. Unknown options and extra arguments are rejected. Without `--json`, the existing progress messages are preserved.

## Stop

`moor stop api --json` stops the project's container without deleting its configuration or volumes. Success prints the API response as one JSON document; human mode prints a confirmation. Request failures go to stderr and exit 1. Missing projects, unknown options, and extra arguments fail without a stop request.

The API treats already-stopped or absent containers as success. A Docker failure returns an error without marking the project stopped; a failed request does not prove the container's current state. Use project inspection to check its live state.

## Rebuild

`moor rebuild api --json` emits one `{event,data}` JSON object per line as the API builds and starts the project. Use `--no-cache` to bypass the build cache. Human mode retains progress and log output.

Failures before streaming emit one JSON error document on stderr. Stream failures emit JSONL error events on stdout and exit nonzero. A stream ending without a completion or error event also fails. Unknown options and extra arguments are rejected.

## Environment variables

`moor env delete api OLD_KEY OTHER_KEY --json` removes matching keys in one server operation. The response lists `deleted_keys`, `missing_keys`, and `restarted`. Missing keys are a no-op; stopped projects are not started. Running projects restart only after an actual deletion. Drain rejects restart-requiring deletion before changing values.

If restart fails after deletion, the command exits nonzero and reports the deleted keys with `env_updated: true`; it does not roll the deletion back. Keys are trimmed and deduplicated before matching, consistent with environment writes. The legacy single-key API deletion remains configuration-only.

List a project's environment values as one JSON document for agents:

```bash
moor env list api --json
```

Without `--json`, the command preserves the existing `KEY=VALUE` output. Unknown options and extra arguments are rejected.

The existing human syntax remains available:

```bash
moor env set api PORT=3000
```

For agents, pass a JSON object through a file or stdin so values do not appear in command arguments:

```bash
printf '%s' '{"DATABASE_URL":"..."}' | moor env set api --env-file - --json
```

The command merges the supplied keys and restarts the project only when it is running. JSON success is one document containing `updated_keys` and `restarted`. Failures are written as JSON to stderr with a non-zero exit status; if values were saved but restart failed, the error retains `env_updated` and `updated_keys`.

## `moor project deploy`

Deploy from GitHub or a registry image through the same API operation used by MCP:

```bash
moor project deploy api --github-url https://github.com/example/api
moor project deploy web --docker-image nginx:alpine --domain web.example.com --domain-port 80
moor project deploy private --github-url https://github.com/example/private --source-credential-id 42
moor project deploy db --docker-image postgres:17 --volume data:/var/lib/postgresql/data
```

Repeat `--volume <name>:<target>` to add named persistent volumes. Targets are absolute container paths, not host paths. Mount modes such as `:ro` and colons in targets are not supported by this flag. With `--update-existing`, existing mounts are retained; an identical name and target is accepted, but changing a mount's target is rejected. Omitting `--volume` does not remove mounts. The server validates names, paths, and conflicts.

Pass `--update-existing` to update a project with the same name, or `--no-run` to save its configuration without rebuilding or starting it. Environment values are read from a JSON object so secrets do not appear in the command line:

```bash
printf '%s' '{"DATABASE_URL":"..."}' | \
  moor project deploy api --github-url https://github.com/example/api --env-file -
```

Set resource caps with `--memory-limit-mb 256 --cpus 0.5`. Memory uses integer MB and allows no extra swap; CPU counts may be fractional. The server enforces minimums (6 MB and 0.001 CPUs) and host capacity. Pass `unlimited` to either option to clear that cap; zero is not a clearing value. Omitted limits remain unchanged with `--update-existing`. With `--no-run`, new limits take effect on the next container recreation, such as a restart.

Use `--files files.json` to read a JSON array of injected files, or `--files -` for stdin:

```json
[
  {"path":"/etc/app/config.json","content":"{\"debug\":false}","mode":"0644"},
  {"path":"/etc/app/token","env_ref":"TOKEN","mode":"0600"}
]
```

Each entry supplies exactly one of `content` or `env_ref`; the server validates paths and modes. Referenced env keys must exist when the container starts, either already stored or supplied with `--env-file` in this deploy. File contents stay out of command-line arguments. Only one of `--files` and `--env-file` can read stdin.

With `--update-existing`, entries replace file configuration at matching paths; omitted files are retained. `--no-run` saves configuration without injecting files until the next container creation, such as a restart.

Agents should pass `--json`. Each streamed API event is emitted as one JSON object per line:

```json
{"event":"deploy","data":{"action":"created","project_id":1,"project_name":"api","env_keys":[],"run":true,"env_changes_pending_restart":false}}
{"event":"done","data":"Container started"}
```

Failures return a non-zero exit status. Pre-stream errors are written to stderr and, in JSON mode, preserve the API's structured fields plus the HTTP `status`. Errors received after streaming begins remain ordered with the other JSONL events on stdout.

## Private-source credentials

Use `moor credential source list --json` to discover stored credential IDs. Create one from a protected JSON file, or pipe the object through stdin with `--file -`; do not put its secret in command-line arguments.

```bash
moor credential source create --file credential.json --json
moor credential source check --github-url https://github.com/acme/app --source-credential-id 8 --json
moor project deploy app --github-url https://github.com/acme/app --source-credential-id 8 --json
```

The creation object has `hostname`, `label`, `username`, `secret`, and optional `expires_at` fields. Responses contain metadata, not the stored secret. The server validates credential fields. Rotation and deletion are not exposed in this CLI slice.

`check` contacts the repository and may update the credential's stored state and last-check result. It is not a read-only operation. Add `--branch` to check a specific branch. Without an explicit ID, a successful check may return `auto_selected_credential_id`; pass that ID explicitly when deploying. Deploy does not automatically select a credential. If selection is ambiguous, JSON stderr preserves the server's `candidates` list and exits 1.

These commands emit one JSON document with `--json`. Failures use stderr and exit 1. Human list/create output shows ID, hostname, label, and state; human check output shows the response as formatted JSON.

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
