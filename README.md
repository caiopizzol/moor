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

## Prerequisites

- Docker Engine 25.0+ and the Compose v2 plugin. Moor uses the Docker Engine API at version `v1.44`, which was introduced in Engine 25.0. Install from Docker's official repository: <https://docs.docker.com/engine/install/>.
- A Linux host you control. Moor mounts `/var/run/docker.sock`, so the moor admin is effectively root on the host. Treat the login like SSH access.

## Quick Start

```bash
curl -fsSL moor.sh/install | sh
docker compose up -d
```

The installer fetches `docker-compose.yml` and writes a `.env` pinning the Compose project name. Moor runs behind Caddy on ports 80/443.

### First-boot security

On first boot, moor exposes an unauthenticated setup page for the initial password. Do not expose the admin publicly until that password is set. Two safe options:

- **SSH tunnel (simplest).** Before `docker compose up -d`, bind Caddy to loopback in `docker-compose.yml`:

  ```yaml
  ports:
    - "127.0.0.1:80:80"
    - "127.0.0.1:443:443"
    - "127.0.0.1:443:443/udp"
  ```

  Then from your laptop: `ssh -L 8080:localhost:80 your-server`, open `http://localhost:8080`, set the password. Revert the binds after the domain is configured.

- **Network firewall allowlist.** If your provider offers a cloud firewall (Hetzner, AWS, etc.), restrict TCP 80/443 to your IP for setup. Host-level UFW does not work for this: Docker programs iptables directly and bypasses UFW's `INPUT` chain. See <https://docs.docker.com/engine/network/packet-filtering-firewalls/>.

### Custom domain for the admin UI

The moor admin and project routes use the same Caddyfile but are managed differently. Project domains are added through the UI (they're written to `/app/data/moor-routes`). The admin's own site address lives at the top of `/app/data/Caddyfile` and must be edited directly. After DNS points at your server:

```bash
docker compose exec -T moor sh -c 'cat > /app/data/Caddyfile' <<'EOF'
moor.example.com {
  header {
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
  reverse_proxy moor:3000
}

# Domain routes managed by Moor - do not edit manually
import /app/data/moor-routes
EOF

docker compose exec caddy caddy reload --config /app/data/Caddyfile --adapter caddyfile
```

Caddy auto-provisions a Let's Encrypt certificate on the first request to the domain.

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
