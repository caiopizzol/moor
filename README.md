# <img src="https://github.com/user-attachments/assets/a042df26-2839-415a-b38b-f0e969f4068c" width="32" height="32" alt="moor" /> moor

[![GitHub release](https://img.shields.io/github/v/release/caiopizzol/moor?label=version)](https://github.com/caiopizzol/moor/releases)

Self-hosted container management for a single VM. Deploy, monitor, and manage Docker containers through a clean web UI.

## What it does

- Build Docker images from GitHub repos
- Start, stop, restart, and rebuild containers
- Stream build output and container logs in real time
- Web terminal into running containers
- Manage environment variables per project

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
