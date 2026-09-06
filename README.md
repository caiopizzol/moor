# <img src="https://github.com/user-attachments/assets/a042df26-2839-415a-b38b-f0e969f4068c" width="32" height="32" alt="moor" /> moor

[![Moor release](https://img.shields.io/github/v/release/caiopizzol/moor?filter=v*&label=moor)](https://github.com/caiopizzol/moor/releases)
[![@moor-sh/cli on npm](https://img.shields.io/npm/v/@moor-sh/cli?label=CLI)](https://www.npmjs.com/package/@moor-sh/cli)
[![@moor-sh/mcp on npm](https://img.shields.io/npm/v/@moor-sh/mcp?label=MCP)](https://www.npmjs.com/package/@moor-sh/mcp)

Self-hosted Docker control panel for a single server. Build, deploy, and manage containers from a web UI, CLI, or AI agent.

<img width="1063" height="698" alt="Moor web interface" src="https://github.com/user-attachments/assets/4b47d9ba-817f-47a4-bee5-ce35a45ea410" />

## What it does

- Build Docker images from GitHub repos, public or private
- Deploy from private registries (GHCR, Docker Hub, self-hosted)
- Start, stop, restart, and rebuild containers
- Stream build output and container logs; open a web terminal
- Schedule cron jobs inside containers
- Manage environment variables, persistent volumes, and injected files per project
- Override a container's command and entrypoint without a Dockerfile
- Route custom domains to containers with HTTPS
- Inspect container stats and stored run history
- Maintain the host with drain mode, self-update, database backups, and image cleanup

## Quick start

Install [Docker Engine 25.0+](https://docs.docker.com/engine/install/) with the Compose v2 plugin, then run on your server:

```bash
mkdir -p moor && cd moor
curl -fsSL moor.sh/install | sh
docker compose up -d
```

The installer creates `docker-compose.yml` and `.env` in the current directory. It saves a random `MOOR_INITIAL_PASSWORD` in `.env` and prints it for your first login.

## First login

The admin UI listens on `127.0.0.1:3000` by default. Caddy on ports 80/443 serves only project domains you add later. To reach the admin UI, open an SSH tunnel from your laptop:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
```

Then open `http://localhost:8080` and log in with the password from `.env`.

> **Host access:** Moor mounts `/var/run/docker.sock`. Anyone with admin access or a valid `MOOR_API_KEY` effectively controls the host. Treat both like SSH access.

See the [self-hosting guide](docs/self-hosting.md) for admin domains, API keys, project ports, and private repositories and registries.

## CLI and MCP

Both packages require [Bun](https://bun.sh) on the machine running them.

For the [CLI](packages/cli/README.md), set `MOOR_URL` and `MOOR_API_KEY` in your environment, then run:

```bash
bunx @moor-sh/cli status   # one-shot
bun add -g @moor-sh/cli    # or install globally; then `moor status`
```

To connect an AI agent, generate a config snippet for the [MCP server](packages/mcp/README.md):

```bash
bunx @moor-sh/cli mcp config --client claude-code   # or --client codex
```

The generator reads `MOOR_API_KEY` from your environment or `.env` and defaults to the SSH tunnel at `http://127.0.0.1:8080`. Pass `--url` for another server address. Paste the output into your client's config file; see the package guides above for details.

## Development

```bash
bun install
bun run dev:api   # API with hot reload
bun run dev:web   # Vite+ dev server
```

Run `bun run check` for Vite+ format/lint checks, workspace typechecks, and Bun tests.
Tests (including SQLite tests) and CLI/MCP bundles require Bun; `vp test` runs Vitest and does not run these suites.

`bun install` enables Vite+ commit hooks. They run staged format/lint checks and
typechecking; installs without development dependencies skip hook setup.

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket).

## Contributors

<a href="https://github.com/caiopizzol"><img src="https://github.com/caiopizzol.png" width="50" height="50" alt="caiopizzol" title="Caio Pizzol" /></a>
