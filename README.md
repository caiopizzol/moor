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

- Docker Engine 25.0+ and the Compose v2 plugin. Moor uses the Docker Engine API at version `v1.44`, which was introduced in Engine 25.0. Install from Docker's official repository: <https://docs.docker.com/engine/install/>.
- A Linux host you control. Moor mounts `/var/run/docker.sock`, so the moor admin is effectively root on the host. Treat the login like SSH access.

## Quick Start

```bash
curl -fsSL moor.sh/install | sh
docker compose up -d
```

The installer fetches `docker-compose.yml` and writes a `.env` pinning the Compose project name. Moor runs behind Caddy on ports 80/443.

### Accessing the admin

The admin UI is bound to the host's loopback interface (`127.0.0.1:3000`) by default. Caddy serves only project domains on 80/443. To reach the admin, open an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
```

Then open `http://localhost:8080` in your browser. The first request shows a setup page where you set the initial admin password. Until that password is set, the page is unauthenticated — keep it off the public network by leaving the default loopback bind in place.

To expose the admin publicly later, either change `127.0.0.1:3000:3000` to `3000:3000` in `docker-compose.yml` (not recommended without an external auth proxy), or add an explicit admin domain block to `/app/data/Caddyfile` (see "Custom domain for the admin UI" below).

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

### Project port exposure

When moor deploys a project container, the container's `EXPOSE`d ports are also published on the host, but bound to `127.0.0.1` (loopback) only. The public path is always Caddy on 80/443 reaching the container over the internal Docker network. Host ports exist for local debugging from inside the VM:

```bash
ssh your-server
curl http://localhost:8080  # the host port shown for the project in the moor admin
```

Your network firewall should keep direct project port ranges closed regardless. Caddy is the only intended public entry point.

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
