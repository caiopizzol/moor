# Moor

Minimal self-hosted Docker management for a single VM. Manage containers, cron jobs, and environment variables through a clean web UI.

## What it does

- Build Docker images from GitHub repos
- Start, stop, and monitor containers
- Schedule cron jobs that run inside containers
- Manage environment variables per project
- View run history with logs and exit codes

## Quick Start

```bash
curl -O https://raw.githubusercontent.com/caiopizzol/moor/main/docker-compose.yml
docker compose pull && docker compose up -d
```

Binds to `127.0.0.1:3000`. Access via SSH tunnel:

```bash
ssh -L 3000:localhost:3000 user@your-server
```

## Development

```bash
bun install
bun run dev:api   # API with hot reload
bun run dev:web   # Vite dev server
```

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket)
