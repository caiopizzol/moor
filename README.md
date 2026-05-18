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

### First boot

The installer generates a random `MOOR_INITIAL_PASSWORD` and writes it to `.env` on the host. It also prints the password at the end of the install output. Save that password; you will need it for the first login.

Moor fails closed when no admin password is configured (every API route returns 503 except `/api/health`), so the env var is required on a fresh install. The variable is create-only: once an admin exists, it is ignored with a warning, so leaving it in `.env` is safe. If you prefer to set the password yourself, edit `.env` before `docker compose up -d`.

To reach the admin, open an SSH tunnel from your laptop:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
```

Then open `http://localhost:8080` and log in with the password you set. The admin is bound to `127.0.0.1:3000` by default; Caddy on 80/443 serves only project domains. To expose the admin publicly later, either change `127.0.0.1:3000:3000` to `3000:3000` in `docker-compose.yml` (not recommended without an external auth proxy), or add an explicit admin domain block to `/app/data/Caddyfile` (see "Custom domain for the admin UI" below).

To reset a forgotten admin password, set `MOOR_RESET_PASSWORD` instead of `MOOR_INITIAL_PASSWORD` and restart. That env var clears all sessions in addition to rewriting the password. Don't set both at the same time - moor refuses to start.

### Custom domain for the admin UI

The moor admin and project routes use the same Caddyfile but are managed differently. Project domains are added through the UI (they're written to `/app/data/moor-routes`). The admin's own site address lives at the top of `/app/data/Caddyfile` and must be edited directly. After DNS points at your server:

```bash
docker compose exec -T moor sh -c 'cat > /app/data/Caddyfile' <<'EOF'
:80 {
  respond 421
}

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

### API key

`MOOR_API_KEY` enables bearer-token access for the CLI, MCP, and any external tooling. **Treat the value like SSH access** - moor mounts `/var/run/docker.sock`, so a valid bearer token grants full root-equivalent control of the host. The web UI is unaffected; it uses session cookies and an admin password.

The shipped `docker-compose.yml` already references `MOOR_API_KEY` from `.env`, so enabling it is a `.env` edit, not a compose change.

**Generate at install time** (opt-in flag):

```bash
curl -fsSL moor.sh/install | sh -s -- --with-api-key
```

The installer writes a random 40-character key to `.env` and prints it once.

**Enable on an existing install**:

```bash
echo "MOOR_API_KEY=$(head -c 80 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >> .env
docker compose up -d
```

**Verify**:

```bash
KEY=$(grep '^MOOR_API_KEY=' .env | cut -d= -f2-)
curl -i -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/api/projects
```

`200` means the key works. `401` with the bearer means the value in `.env` doesn't match what the container is using - check that `docker compose up -d` ran after the `.env` edit.

**Rotate**:

```bash
sed -i "s|^MOOR_API_KEY=.*|MOOR_API_KEY=$(head -c 80 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)|" .env
docker compose up -d
```

Old key stops working immediately on container restart. Update any CLI/MCP configs with the new value.

## MCP Server

Connect any MCP-compatible AI agent (Claude Code, Cursor, etc.) to manage your moor projects via stdio. The server ships as a standalone npm package - no repo clone needed.

### Setup

1. **Generate or set `MOOR_API_KEY` on your moor server.** Easiest path is the installer's opt-in flag, which writes a strong random key into `.env` and prints it once:

   ```bash
   curl -fsSL moor.sh/install | sh -s -- --with-api-key
   ```

   Or add `MOOR_API_KEY=<random>` to `.env` manually. See [API key](#api-key) for the full reference. Treat the value like SSH access - it grants full admin control of the host.

2. **Restart moor** so the new env var is picked up:

   ```bash
   docker compose up -d
   ```

3. **For a remote moor with private admin** (the default), open an SSH tunnel from the laptop running your MCP client:

   ```bash
   ssh -fNL 8080:127.0.0.1:3000 your-server
   ```

   `-fN` runs ssh backgrounded with no remote command. The tunnel must stay up while the MCP client is in use. Skip this step if moor is on the same machine as the client.

4. **Configure the MCP client** by pasting one of the snippets below into its config file.

   **Claude Code** (`~/.claude.json`):

   ```json
   {
     "mcpServers": {
       "moor": {
         "command": "bunx",
         "args": ["@moor-sh/mcp"],
         "env": {
           "MOOR_URL": "http://127.0.0.1:8080",
           "MOOR_API_KEY": "your-api-key"
         }
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.moor]
   command = "bunx"
   args = ["@moor-sh/mcp"]

   [mcp_servers.moor.env]
   MOOR_URL = "http://127.0.0.1:8080"
   MOOR_API_KEY = "your-api-key"
   ```

   For a moor running on the same machine as the client, change `MOOR_URL` to `http://localhost:3000` and skip step 3.

5. **Smoke-test auth and connectivity** before relying on the integration:

   ```bash
   MOOR_URL=http://127.0.0.1:8080 MOOR_API_KEY=your-api-key bunx @moor-sh/mcp < /dev/null
   ```

   Silence means it connected, authenticated, and is waiting for an MCP client on stdio (the process won't print anything else). Any stderr line tells you what's wrong:

   - `Cannot reach moor at ...` - URL unreachable or tunnel is down.
   - `Authentication failed` - `MOOR_API_KEY` doesn't match the server.
   - `moor at ... returned 503` - admin password not configured (see [First boot](#first-boot)).

   Restart your MCP client after a successful smoke test for it to pick up the new config.

6. **Rotate or remove the key.** Rotating `MOOR_API_KEY` on the server means updating every MCP client config that uses it - the bearer is checked on every request, including each MCP-server startup. To revoke MCP access entirely, remove the `MOOR_API_KEY=` line from the server's `.env` and `docker compose up -d`. Bearer auth disables; the web UI keeps working through session cookies.

## Stack

Bun, SQLite, React, Vite, Docker Engine API (Unix socket)
