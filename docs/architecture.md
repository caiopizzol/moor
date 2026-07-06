# Architecture

This doc is the map: what moor does, how the pieces fit, and where a new feature's code belongs. It is written for a contributor who wants to know where a change lives before writing it. For scope and non-goals, read [`brand.md`](../brand.md); this doc does not repeat them.

## Surface hierarchy

Moor has one product with four ways in. They are not peers.

1. **HTTP API (`apps/api`) is the source of truth.** Every capability is an API route. It owns the SQLite state, the Docker socket, and all business logic. Nothing else in the repo does work the API cannot do.
2. **MCP (`packages/mcp`) is the complete agent and operator surface.** It mirrors the full API: every lane below has MCP tools, including the API-only ones the web UI never shows. An agent driving moor should be able to do anything through MCP. When you add an API capability, add the matching MCP tool.
3. **Web UI (`apps/web`) is a monitoring and happy-path console, partial by design.** It covers projects, builds, logs, terminal, env, cron, ports, and domains. Volumes, file injection, command/entrypoint overrides, credentials, drain, self-update, backups, and cleanup are deliberately not in the UI. Do not treat UI parity as a goal.
4. **CLI (`packages/cli`) is a small utility surface and stays small.** A handful of one-shot commands (status, logs, rebuild, restart, exec, env, stats, history) plus MCP config generation. It is a convenience layer, not a second full client. Resist growing it toward API parity.

## Lanes

Capabilities group into four lanes. This is the vocabulary to use when deciding where a feature goes.

**Deploy** is the core: a project deployed from GitHub source or a registry image, then everything that shapes how its container runs. Env vars, published ports, named volumes, injected files, command/entrypoint overrides, build (git pull + docker build) and run (recreate from image), and streaming build and container logs. This is most of the surface area and most of the day-to-day loop (see [`agent-workflow.md`](agent-workflow.md)).

**Observe** is read-only visibility: host stats (CPU, memory, disk), live per-container stats, stored per-minute resource history, and lifecycle events from the Docker event stream. It answers "what is happening" and "what happened," without changing anything.

**Operate** is host upkeep: auth (admin password plus `MOOR_API_KEY` bearer), DB backups, drain mode, dangling-image cleanup, and self-update via a transient respawner container. These keep a single unattended server healthy over time.

**Agent surface and UI** are the ways in from the hierarchy above: MCP and CLI for programmatic and agent use, the web console for eyes-on monitoring.

## Decision: operate is core, not an add-on

Self-update, drain, backup, and cleanup are core agent-ops features, not conveniences bolted onto a container manager. Moor's point is agent-managed deployment on a single bare-metal server, and a server an agent runs unattended has to maintain itself: update its own image, drain before maintenance, snapshot its DB before a risky change, reclaim disk that builds leak. Without these, "never SSH in to maintain it" breaks the first time the host needs upkeep, and the agent story falls back to a human on a terminal.

There is a real tension here, recorded on purpose. `brand.md` scopes moor as "one server, a thin interface over Docker." Self-update is the least thin subsystem in the codebase: it spawns a separate respawner container that replays the operator's Compose stack, retags images, polls health, and rolls back. We accept that weight because never-SSH-to-maintain is central to the agent-operated story, and the alternative (an agent that can deploy but not keep its own host alive) fails the promise. The subsystem stays quarantined in `apps/respawner` plus the `update-*` modules so the rest of the API stays thin.

## Map: apps and packages

**apps**
- `api`: the HTTP API. Source of truth: SQLite state, Docker socket, all business logic. Route handlers in `routes/`, domain logic in the top-level modules beside them.
- `web`: React + Vite admin console. The monitoring and happy-path UI.
- `respawner`: transient container that performs a self-update (pull, retag, `compose up`, health-check, rollback) and then exits. No daemon, no open ports.
- `site`: the static marketing/install site (`moor.sh`), including the install script.

**packages**
- `contract`: shared TypeScript types, a thin `fetch`-based API client, and request validators. The typed contract between the API and its clients; consumed by `web` and `mcp`.
- `mcp`: the MCP server. The complete agent/operator surface, one tool module per lane under `src/tools/` (projects, env, exec, runs, cleanup, credentials, server, update, context).
- `cli`: the small CLI utility. One file per command under `src/commands/`.

## Where a new feature goes

Start in the API; everything else follows from it.

1. **Add the capability to `apps/api`.** New route handler in `apps/api/routes/`, domain logic in a sibling module, migrations/state in `db.ts`. This is non-optional: if it is not in the API, it does not exist.
2. **Add types, client changes, and validators to `packages/contract`** so clients share one definition.
3. **Add the matching MCP tool** in the lane's module under `packages/mcp/src/tools/`. MCP mirrors the full API, so this is expected for every capability, not just user-facing ones.
4. **Add web UI only if it belongs to the happy path** (deploy/observe basics). Operate-lane and advanced deploy features stay API/MCP-only by design; do not add UI for them without a reason.
5. **Add a CLI command only if it is a common one-shot** an operator wants from a shell. The default is no: the CLI stays small.

By lane: deploy and observe features land in the project/stats/history/runs API modules and their MCP counterparts, and usually get UI. Operate features land in the `drain`, `db-backup`, `cleanup`, and `update-*` API modules plus `respawner`, with MCP tools but no UI.

## Acceptance bar

A new contributor should be able to answer, before writing code: which lane is this, does it belong in the API (always yes), which MCP tool module gets it, and does it earn a place in the web UI or CLI (usually no). If those answers are clear from this doc, it has done its job.
