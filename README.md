# <img src="https://github.com/user-attachments/assets/a042df26-2839-415a-b38b-f0e969f4068c" width="32" height="32" alt="moor" /> moor

[![GitHub release](https://img.shields.io/github/v/release/caiopizzol/moor?label=version)](https://github.com/caiopizzol/moor/releases)

Self-hosted Docker control panel for a single server. Build, deploy, and manage containers with cron, logs, and a web terminal.

<img width="1280" height="720" alt="moor app" src="https://github.com/user-attachments/assets/c9aec88f-df93-4c40-9968-0a4cbb6df394" />

## What it does

- Build Docker images from GitHub repos
- Start, stop, restart, and rebuild containers
- Stream build output and container logs in real time
- Web terminal into running containers
- Schedule cron jobs inside containers
- Manage environment variables per project
- Route custom domains to containers with HTTPS

## Quick Start

```bash
curl -fsSL moor.sh/install | sh
docker compose up -d
```

Moor runs behind Caddy (included) on ports 80/443. Edit the `Caddyfile` to replace `:80` with your domain for automatic HTTPS.

## Development

```bash
bun install
bun run dev:api   # API with hot reload
bun run dev:web   # Vite dev server
```

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket)
