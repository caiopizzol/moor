# <img src="https://github.com/user-attachments/assets/a042df26-2839-415a-b38b-f0e969f4068c" width="32" height="32" alt="moor" /> moor

[![GitHub release](https://img.shields.io/github/v/release/caiopizzol/moor?label=version)](https://github.com/caiopizzol/moor/releases)

Self-hosted Docker control panel for a single server. Build, deploy, and manage containers with cron, logs, and a web terminal.

<img width="1063" height="698" alt="image" src="https://github.com/user-attachments/assets/4b47d9ba-817f-47a4-bee5-ce35a45ea410" />

## What it does

- Build Docker images from GitHub repos
- Start, stop, restart, and rebuild containers
- Stream build output and container logs in real time
- Web terminal into running containers
- Schedule cron jobs inside containers
- Manage environment variables per project
- Route custom domains to containers with HTTPS
- CLI and MCP server for AI agent integration

## Prerequisites

Docker Engine 25.0+ with the Compose v2 plugin. Install from <https://docs.docker.com/engine/install/>.

## Quick start

```bash
curl -fsSL moor.sh/install | sh
docker compose up -d
```

The installer downloads `docker-compose.yml` and writes a random `MOOR_INITIAL_PASSWORD` into `.env`. The password is printed at the end of the install output - save it for the first login.

## First login

Moor's admin is bound to `127.0.0.1:3000` by default (Caddy on 80/443 serves only project domains you add later). Open an SSH tunnel from your laptop:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
```

Then open `http://localhost:8080` and log in with the password from `.env`.

> **Trust boundary.** Moor mounts `/var/run/docker.sock`. Anyone with moor admin access or a valid `MOOR_API_KEY` effectively controls the host. Treat both like SSH access.

## Docs

- [Self-hosting guide](docs/self-hosting.md) - first boot, admin domain, API keys, project ports, Docker socket
- [`@moor-sh/cli`](packages/cli) - command-line interface
- [`@moor-sh/mcp`](packages/mcp) - MCP server for AI agents

## CLI

```bash
bunx @moor-sh/cli status   # one-shot
bun add -g @moor-sh/cli    # or install globally; then `moor status`
```

Reads `MOOR_URL` and `MOOR_API_KEY` from the environment. See [`packages/cli/README.md`](packages/cli/README.md) for the full command list.

## MCP server

```bash
bunx @moor-sh/cli mcp config --client claude   # or --client claude-code / --client codex
```

Prints a ready-to-paste config snippet for Claude Code or Codex that wires `@moor-sh/mcp` into the client. See [`packages/mcp/README.md`](packages/mcp/README.md) for the full setup walkthrough.

## Development

```bash
bun install
bun run dev:api   # API with hot reload
bun run dev:web   # Vite dev server
```

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket).
