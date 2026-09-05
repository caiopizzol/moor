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

## Run inspection and cancellation

`moor run list api --page 1 --json` returns `{runs,total}` with 20 summaries per page and no stdout/stderr bodies. `moor run get 11 --json` returns the run metadata and the last 8192 bytes of each output stream. Use `--tail-bytes 0` for metadata only, or up to 65536 bytes per stream.

Detail output includes `stdout_truncated` and `stderr_truncated` flags and preserves total byte counts. UTF-8 characters are not split. The CLI limits displayed output after fetching the stored run; it does not limit the API download. Server-side retention may already have removed older output.

For list/get, exit 0 means the read succeeded, even if the recorded run has a nonzero `exit_code`. Argument and request failures exit 1 and put errors on stderr. Without `--json`, list shows summary lines and get shows indented JSON.

`moor run stop 11 --json` attempts cron/build cancellation once. Use an ID from `cron run` or `run list`, never from `job start`. Build cancellation is available only during the build/pull phase. Successful cancellation outcomes go to stdout and exit 0; HTTP errors (including 409 outcomes such as `cron_kill_incomplete`) go to stderr and exit 1, preserving server details. An HTTP-success body with `ok:false` also exits 1, on stdout. Human mode prints indented outcome JSON.

Inspect `result`, `message`, and `live_remaining` when present. Incomplete cancellation can leave processes running, and the kill attempt can remove the tracking pidfile: do not retry blindly. There is no automatic retry or polling. Use `run get` to inspect the recorded outcome.

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

### Worker command and entrypoint

Use JSON argv arrays to override the image's command or entrypoint. This example assumes your image contains Node and `/app/worker.js`; replace the image reference with your own:

```bash
moor project deploy worker --docker-image ghcr.io/acme/worker:latest --entrypoint '["node"]' --command '["/app/worker.js"]' --json
moor project deploy worker --update-existing --command null --entrypoint null --json
```

Arguments are passed as array elements, not split or expanded by the CLI. Quote the JSON to prevent your local shell from expanding it. Use environment variables or injected files for secrets, not command arguments. These options configure container startup; they do not execute a command inside an existing container.

Omitted options preserve existing overrides on updates. `null` restores image defaults; the server treats `[]` the same way, not as “run nothing.” The API validates array entries. Overrides take effect on container recreation; `--no-run` saves them until a later restart or rebuild. `--json` controls output independently of the JSON input arrays.

## Asynchronous shell jobs

```bash
moor job start worker --file job.json --json
moor job status 12 --json
moor job stop 12 --json
```

Start reads `{"command":"node /app/task.js","timeout_ms":3600000}` from a file or stdin (`--file -`). The API validates the shell command and timeout, which defaults to 24 hours and ranges from 60,000 to 86,400,000 milliseconds. Keep secrets in environment variables or injected files rather than command text, which the server stores and logs.

Start returns `run_id` when accepted, without waiting for completion. Use that ID only with `job status/stop`: async jobs have a separate ID space from build/cron `run` records. Existing `moor exec` remains the synchronous command. Status returns live output tails while running, final output afterward, byte totals, and execution state. Empty initial output is normal; status exit 0 means retrieval succeeded even if the job failed.

Stop attempts cancellation once. Inspect `ok`, `state`, `live_remaining`, and `message`: an error can mean processes are still running. Do not retry blindly; the server cannot reliably repeat a failed kill attempt. The CLI does not poll or retry start/stop. An HTTP-success stop outcome is printed to stdout and exits 1 if `ok` is false; HTTP request failures go to stderr and exit 1. A successful start or status request exits 0, not the command's eventual exit code. Human output is indented JSON; `--json` emits one compact document.

## Scheduled jobs

```bash
moor cron list worker --json
moor cron create worker --file job.json --json
moor cron update 12 --file patch.json --json
moor cron run 12 --json
```

Create reads a JSON object with `name`, `schedule`, and `command`; `timeout_ms` and `enabled` are optional. For example, `job.json` can contain:

```json
{"name":"daily","schedule":"0 3 * * *","command":"node /app/job.js","enabled":false}
```

Jobs are enabled by default; `enabled: false` stages a disabled job without an active scheduling window. Update accepts a patch of the same fields, so `{"enabled":false}` disables an existing job. Both commands accept stdin with `--file -`; keep shell commands in the JSON input rather than expanding them in your local shell. The container interprets `command` through `sh -c` when the job runs.

Schedules use five numeric cron fields in the API process's local timezone, with Sunday numbered 0. The API validates schedule and timeout values. Creating or updating configuration does not manually trigger a run, but an enabled job is eligible at its scheduled time. This requires a running project container.

`cron run` triggers one execution immediately, even for a disabled schedule. It returns `{ok:true,run_id}` without waiting; exit 0 means acceptance, not workload success. Inspect the returned ID with `moor run get <run_id> --json`, not `job status`. No automatic retries or polling occur. A failed request or unusable response may leave the outcome uncertain; do not blindly repeat a trigger.

`--json` returns one document; human mode prints indented JSON. Exit 0 reports a successful request, not a successful job execution. Inspect results with `moor run list <project> --json` and `moor run get <id> --json`. Deletion is not exposed by these commands.

## Private-image registry credentials

Store credentials from a protected JSON file, or pipe the object through stdin with `--file -`. Never put secrets in command-line arguments.

```bash
moor credential registry list --json
moor credential registry create --file registry.json --json
moor credential registry update --registry-credential-id 9 --file rotation.json --json
```

Create accepts `hostname`, `username`, and `secret`. Update accepts only `username` and/or `secret`; omitted fields stay unchanged. The API validates fields and returns metadata, not the stored secret. Hostnames cannot be patched, and deletion is not exposed in the CLI.

Use a bare hostname such as `ghcr.io` or `registry.example.com:5000`, with no scheme or path. For Docker Hub images such as `user/image`, use `docker.io`. The server selects credentials automatically by the image's registry hostname; there is no registry credential ID to pass when deploying.

Create and update only store credentials: they do not test authentication or pull an image. There is no registry `check` command. Authentication is exercised on the next image pull. When diagnosing a failed pull, the API server's logs report `auth=anonymous` if no matching credential was found, or `auth=host=<hostname>` when one was selected. These credentials cover `docker_image` pulls, not private `FROM` images inside Dockerfile builds.

## Private-source credentials

Use `moor credential source list --json` to discover stored credential IDs. Create one from a protected JSON file, or pipe the object through stdin with `--file -`; do not put its secret in command-line arguments.

```bash
moor credential source create --file credential.json --json
moor credential source check --github-url https://github.com/acme/app --source-credential-id 8 --json
moor project deploy app --github-url https://github.com/acme/app --source-credential-id 8 --json
```

The creation object has `hostname`, `label`, `username`, `secret`, and optional `expires_at` fields. Responses contain metadata, not the stored secret. The server validates credential fields. Deletion is not exposed in the CLI.

To rotate a secret or edit metadata, put only the changed fields in a protected JSON file (or use stdin with `--file -`):

```bash
moor credential source update --source-credential-id 8 --file rotation.json --json
moor credential source check --github-url https://github.com/acme/app --source-credential-id 8 --json
```

The update object accepts `username`, `secret`, `label`, and `expires_at`. Omitted fields stay unchanged; `expires_at: null` clears the expiry. Hostname and state cannot be patched. Update makes one storage request: it does not verify access, restart projects, or restore a failed credential to active. Run an explicit `check` afterward; a successful check restores active state.

`check` contacts the repository and may update the credential's stored state and last-check result. It is not a read-only operation. Add `--branch` to check a specific branch. Without an explicit ID, a successful check may return `auto_selected_credential_id`; pass that ID explicitly when deploying. Deploy does not automatically select a credential. If selection is ambiguous, JSON stderr preserves the server's `candidates` list and exits 1.

These commands emit one JSON document with `--json`. Failures use stderr and exit 1. Human list/create output shows ID, hostname, label, and state; human check output shows the response as formatted JSON.

## Server database backup

`moor server backup --json` creates a SQLite snapshot next to the database on the server. The server prunes older snapshots, keeping the seven most recent. This is not a volume or full-server backup, an offsite copy, or a download to your computer.

The command makes one request without retries, drain changes, or updates. Success returns `path` (on the server), `sizeBytes`, and `durationMs` as one JSON document; without `--json`, it prints formatted JSON. Errors use stderr and exit 1. A lost or invalid response does not prove that no snapshot was created: inspect the server before retrying, because another backup also applies retention.

## Server drain

```bash
moor server drain status --json
moor server drain enable --reason "maintenance" --ttl-minutes 30 --json
moor server drain disable --json
```

Drain refuses new work without killing work already running. Status returns the server's `state` and `active_work` counts; enable and disable return `state`. These commands make one request and do not wait, poll, or retry. Reads remain available during drain.

TTL must be finite and positive. Omit it for the server's 30-minute default; the server clamps supplied values to 0.05–10080 minutes. Enabling again replaces the reason and resets expiry from now. Disabling does not restart or resume work. Scheduled cron executions during drain are recorded as skipped.

Success emits one JSON document with `--json`, or formatted JSON for humans. Request failures use stderr and exit 1. The updater-specific `clear_after_version` option is not exposed.

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
