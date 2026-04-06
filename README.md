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
- CLI and MCP server for AI agent integration

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

## CLI

Manage your server from the terminal or let AI agents control it programmatically.

```bash
export MOOR_URL=https://moor.example.com
export MOOR_API_KEY=your-api-key

moor status                          # list all projects
moor logs <project> [-f] [-n 100]    # view container logs
moor rebuild <project>               # rebuild from source
moor restart <project>               # stop + start
moor exec <project> <command>        # run command in container
moor env list <project>              # list env vars
moor env set <project> KEY=VALUE     # set env vars + restart
moor stats                           # server resource usage
```

Enable API key auth by setting `MOOR_API_KEY` in your `docker-compose.yml`:

```yaml
services:
  moor:
    environment:
      - MOOR_API_KEY=your-secret-key
```

## MCP Server

Connect any MCP-compatible AI agent (Claude Code, Cursor, etc.) to manage your projects.

```json
{
  "mcpServers": {
    "moor": {
      "command": "bun",
      "args": ["run", "packages/mcp/src/index.ts"],
      "env": {
        "MOOR_URL": "https://moor.example.com",
        "MOOR_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket)
