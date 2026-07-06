# Recommended agent workflow

The moor MCP server registers over 50 tools. An agent does not need all of them. Most work runs through a small core loop: deploy, watch, act, adjust. This doc is the mental model. The full tool reference lives in [`packages/mcp/README.md`](../packages/mcp/README.md).

## The core loop

Ten tools cover the day-to-day.

| Tool | Use it to |
| --- | --- |
| `moor_status` | List every project with its recorded and live status. The starting point. |
| `moor_project_get` | Read one project's full record and confirm `live_status` after an action. |
| `moor_deploy` | Create or update a project end to end (metadata, env, build/run) in one call. |
| `moor_logs` | Read recent container logs. First stop when a container misbehaves. |
| `moor_exec` | Run a command inside a running container. |
| `moor_env_set` | Set env vars. Restarts the container so the change takes effect. |
| `moor_rebuild` | Rebuild from source (git pull + docker build) and restart. For code changes. |
| `moor_restart` | Recreate from the existing image, no build. For env, port, volume, or limit changes, or to recover a crashed container. |
| `moor_runs` | List build and cron run history for a project. |
| `moor_run_get` | Fetch one run with its stdout and stderr. |

The rebuild-versus-restart split is the one distinction worth internalizing. `moor_rebuild` produces a new image and is slow. `moor_restart` reuses the current image and is fast. Reach for `moor_restart` unless the code or Dockerfile changed.

## A worked flow

Deploy a project from a repo, confirm it, debug it, and ship a fix.

```
1. moor_deploy({ name: "scraper", github_url: "https://github.com/me/scraper",
                 env: { API_KEY: "..." }, run: true })
   → builds, starts, returns the build output

2. moor_project_get({ project: "scraper" })
   → live_status: "running"        // deploy confirmed

3. moor_logs({ project: "scraper" })
   → app is crash-looping on a missing config value

4. moor_env_set({ project: "scraper", env: { TIMEOUT_MS: "30000" } })
   → sets the var and restarts the container

5. moor_logs({ project: "scraper" })
   → still failing; the bug is in the code, not the config

6. moor_rebuild({ project: "scraper" })   // after pushing the fix
   → pulls, rebuilds, restarts, returns the build output

7. moor_runs({ project: "scraper" }) then moor_run_get({ run_id })
   → inspect the build output if the rebuild failed
```

That is the whole loop for most tasks. Deploy, check `live_status`, read logs, adjust env or exec into the container, and rebuild or restart depending on what changed.

## Beyond the core

Reach past the core loop when a task calls for it. These are the common next steps; see [`packages/mcp/README.md`](../packages/mcp/README.md) for the full set.

- **Long-running commands:** `moor_exec_async`, `moor_exec_status`, `moor_exec_stop` for work that outlasts a single `moor_exec` call.
- **Cron:** `moor_cron_create`, `moor_cron_update`, `moor_cron_delete`, `moor_cron_run` to schedule and trigger jobs inside a container.
- **Persistent data and config:** `moor_volume_add` / `moor_volume_list` / `moor_volume_remove` for named volumes, and `moor_file_set` / `moor_file_list` / `moor_file_remove` to inject files.
- **Private sources:** the `moor_registry_credential_*` and `moor_source_credential_*` tools for private registries and repos. Run `moor_source_credential_check` before deploying a private repo.
- **Host and observability:** `moor_stats` for host CPU / memory / disk, `moor_project_stats` for live per-container usage, and `moor_project_history` for stored history.
- **Host upkeep:** `moor_drain_enable` / `moor_drain_status`, `moor_update_apply` / `moor_update_status`, `moor_db_backup`, and `moor_cleanup_plan` / `moor_cleanup_execute`.
