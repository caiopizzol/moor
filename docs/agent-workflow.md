# Recommended agent workflow

Use the Moor CLI for the core loop: deploy, inspect, act, adjust. Start with the [CLI installation and configuration guide](../packages/cli/README.md). The environment must contain `MOOR_URL` and `MOOR_API_KEY`; never print the key or put it in command arguments. It grants admin-equivalent access to the host.

Confirm `moor --version` works, read `moor --help`, then read the relevant command's `--help`. The installed help defines available capabilities. Use `--json` only where advertised; do not infer CLI commands from MCP tool names. The [MCP reference](../packages/mcp/README.md) describes a separate interface, not a CLI command catalog.

## The core loop

| Command | Use it to |
| --- | --- |
| `moor project list --json` | Find projects and their recorded and live status. |
| `moor project get scraper --json` | Inspect configuration and confirm `live_status` after an action. |
| `moor project deploy scraper … --json` | Create or explicitly update a project and build/start it. |
| `moor logs scraper -n 100 --json` | Read recent container logs and log-source state. |
| `moor exec scraper --json -- 'shell command'` | Run a diagnostic without local shell expansion. |
| `moor env set scraper --env-file - --json` | Merge environment values from stdin and restart when applicable. |
| `moor rebuild scraper --json` | Pull source, build a new image, and restart. |
| `moor restart scraper --json` | Recreate the container from its existing image without building. |
| `moor run list scraper --json` | Find build and cron run history. |
| `moor run get 11 --json` | Inspect a returned run ID and its stored output. |

Rebuild when source or the Dockerfile changed. Restart when the current image is still appropriate, such as after configuration changes or to recover a stopped container. Read the mutation's response before adding a restart: environment updates can already restart the container.

Project selectors accept names or numeric IDs; an exact name wins when both match. Inspect the selected project before changing it. Only mutate workloads the user's request authorizes.

## A worked flow

These are separate steps, not a script to run blindly. Replace `OWNER/REPO` with the intended repository, choose the project name, and inspect each result before continuing.

First inspect existing projects. Creating a project with a colliding name should not silently become an update:

```sh
moor project list --json
moor project deploy --help
```

Deploy with environment values supplied through stdin. This example contains only a non-secret setting; use the same input channel for secrets, keeping them out of arguments and shared logs:

```sh
moor project deploy scraper --github-url https://github.com/OWNER/REPO --env-file - --json <<'JSON'
{"TIMEOUT_MS":"30000"}
JSON
```

Deploy emits JSONL: read each `{ "event", "data" }` document and check the process exit code. To intentionally modify an existing project, inspect its configuration and use the documented `--update-existing` option. Do not retry a failed deployment as an update without checking what the server recorded.

Confirm the live state and inspect recent logs:

```sh
moor project get scraper --json
moor logs scraper -n 100 --json
```

A successful read does not mean the container is healthy. Inspect `live_status`, the log response's `state`, and the output. If a configuration change is needed and authorized, merge only the intended keys:

```sh
moor env set scraper --env-file - --json <<'JSON'
{"TIMEOUT_MS":"60000"}
JSON
moor project get scraper --json
```

For a diagnostic, put `--json` before the `--` separator and quote the remote shell expression:

```sh
moor exec scraper --json -- 'printf "%s\n" "$TIMEOUT_MS"'
```

Arguments after `--` are joined as a shell command, not preserved as an argv array. Keep secrets in environment variables or injected files rather than command text. This example prints only the non-secret timeout setting.

After an authorized source fix has been pushed, rebuild:

```sh
moor rebuild scraper --json
moor project get scraper --json
moor run list scraper --json
```

Rebuild also emits JSONL. On failure, inspect run history and use `moor run get <id> --json` with an actual ID from that project. Run output is display-bounded, but the full stored output is downloaded before trimming.

## Interpret results before continuing

- Finite JSON commands emit one document; deploy and rebuild emit JSONL. Check both the exit code and response. Request errors use stderr; mutation or stream results can still appear on stdout when the command exits nonzero.
- Retrieval success is not workload success. For example, `run get` or `job status` can exit 0 while describing failed work.
- `exec` propagates the container command's exit code. A nonzero code with an execution envelope on stdout differs from a CLI/request error on stderr.
- `job start`, `cron run`, and `server update apply` return acceptance, not completion. Inspect the returned ID using the matching command below.
- `job stop` and `run stop` attempt cancellation. An HTTP-success result with `ok:false` remains on stdout and exits 1; inspect the result before retrying.
- A lost or failed mutation response does not prove nothing changed. Inspect current state or audit history before retrying. A server update can disconnect the client, and HTTP failures can follow side effects without rollback.

`moor logs --json --follow` is unsupported. Use finite log reads for machine-readable inspection; do not add unsupported flags or fall back to guessed API calls.

## Beyond the core

Use the [CLI reference](../packages/cli/README.md) and command help when the task needs more:

- **Long-running commands:** `job start` reads command input from a file or stdin; use its returned `run_id` with `job status` or `job stop`. These async execution IDs are separate from build/cron run IDs.
- **Schedules:** `cron list/create/update` configure jobs; `cron run` triggers one and returns a run ID for `run get`, not `job status`. Cancellation of tracked build/cron runs uses `run stop`.
- **Persistent configuration:** deploy accepts named volumes, injected files, resource limits, and command/entrypoint overrides. Existing mounts and omitted injected files are retained during updates; these flags do not provide removal operations. Only one input can consume stdin in a deploy.
- **Private sources:** use the `credential source` or `credential registry` help for file-based onboarding and rotation. Source credentials support an access check; registry storage does not test authentication. Never put credentials in arguments.
- **Observability:** `stats` reports host usage and `history` reports stored project samples and events.
- **Host maintenance:** `server drain`, `server backup`, `server cleanup`, and `server update` have distinct effects. Read their help and obtain authorization for the intended mutation. Cleanup requires a reviewed plan; backups are server-local SQLite snapshots, not volume or offsite backups. Update acceptance returns an `audit_id` to inspect with `server update audit` after reconnecting.

The CLI deliberately does not mirror every MCP tool. If the installed help lacks a required operation, report that gap rather than inventing a command. Further additions should follow demonstrated workflow gaps.
