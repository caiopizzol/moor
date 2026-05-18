# Self-hosting moor

Operating moor on your own server: first-boot password, admin access, API key lifecycle, project port model, and the Docker-socket trust boundary.

The [root README](../README.md) covers the basic install. This doc covers everything else.

## First boot

The installer generates a random `MOOR_INITIAL_PASSWORD` into `.env` and prints it once. Moor uses that value on first start to create the admin user.

Moor **fails closed** when no admin password is configured: every API route returns 503 except `/api/health`. The env var is required on a fresh install. It is **create-only** - once an admin exists, it is ignored with a warning, so leaving the line in `.env` is safe.

To set the password manually instead of letting the installer generate one, edit `.env` before the first `docker compose up -d`:

```bash
MOOR_INITIAL_PASSWORD=your-strong-password
```

To **reset a forgotten admin password**, use `MOOR_RESET_PASSWORD` instead. That env var rewrites the password and clears all sessions:

```bash
echo "MOOR_RESET_PASSWORD=new-password" >> .env
docker compose up -d
# remove the line after the next successful login
```

Don't set both `MOOR_INITIAL_PASSWORD` and `MOOR_RESET_PASSWORD` at the same time - moor refuses to start.

## Reaching the admin

By default the admin is bound to `127.0.0.1:3000` on the host and is NOT served through Caddy. Caddy on 80/443 serves only the project domains you add through the UI.

Open an SSH tunnel from your laptop:

```bash
ssh -L 8080:127.0.0.1:3000 your-server
```

Then open `http://localhost:8080`. For a persistent tunnel that survives sleep and reboots, see the [Persistent tunnel](#persistent-tunnel) section below.

## Admin on a custom domain

To expose the admin publicly at, say, `moor.example.com`:

1. Point an A record at the server's IP.
2. Edit `/app/data/Caddyfile` (inside the `moor-data` volume) to add a site block for your admin domain. The moor admin and project routes share the same Caddyfile but live in different blocks; the admin's own block has to be edited directly. From the host:

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

3. Caddy provisions a Let's Encrypt certificate on the first request to the domain.

The `:80 { respond 421 }` block is the default rejection for any unmatched host. Keep it - it's what stops the server's bare IP from leaking the admin UI.

## API keys

`MOOR_API_KEY` enables bearer-token access for the CLI, MCP, and any external tooling. The web UI is unaffected; it uses session cookies. **A valid `MOOR_API_KEY` grants the same authority as the admin password** - treat it like SSH access.

The shipped `docker-compose.yml` already references `MOOR_API_KEY` from `.env`, so enabling it is a `.env` edit, not a compose change.

### Generate at install time

```bash
curl -fsSL moor.sh/install | sh -s -- --with-api-key
```

The installer writes a random 40-character key to `.env` and prints it once.

### Enable on an existing install

```bash
echo "MOOR_API_KEY=$(head -c 80 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >> .env
docker compose up -d
```

### Verify

```bash
KEY=$(grep '^MOOR_API_KEY=' .env | cut -d= -f2-)
curl -i -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/api/projects
```

`200` means the key works. `401` means the value in `.env` doesn't match what the container is using - check that `docker compose up -d` ran after the `.env` edit.

### Rotate

```bash
sed -i "s|^MOOR_API_KEY=.*|MOOR_API_KEY=$(head -c 80 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)|" .env
docker compose up -d
```

Old key stops working immediately on container restart. Update any CLI / MCP / external client configs with the new value.

### Disable

Remove the `MOOR_API_KEY=` line from `.env` and `docker compose up -d`. Bearer auth disables; the web UI keeps working through session cookies.

## Project ports

When moor deploys a project container, the container's `EXPOSE`d ports are also published on the host - but bound to `127.0.0.1` (loopback) only. The public path is always Caddy on 80/443, reaching the container over the internal Docker network.

Host ports are useful for local debugging from inside the VM:

```bash
ssh your-server
curl http://localhost:8080   # the host port shown for the project in the moor admin
```

Your network firewall should keep direct project port ranges closed regardless. Caddy is the only intended public entry point.

## Docker socket trust boundary

Moor mounts `/var/run/docker.sock` on the host. That means:

- Anyone with admin access to moor can build, run, exec into, or delete any container on the host - including moor itself.
- A valid `MOOR_API_KEY` carries the same authority via the HTTP API.
- A compromise of any moor-managed project container does NOT inherit this authority (project containers do not have the socket mounted), but a compromise of the moor container or any process with the socket does.

In practice: treat the moor admin password and `MOOR_API_KEY` with the same care as an SSH key for the host.

## Persistent tunnel

The quick path is `autossh` (auto-reconnects on network blips, but dies on reboot):

```bash
brew install autossh
autossh -M 0 -fNL 8080:127.0.0.1:3000 \
  -o ServerAliveInterval=60 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes your-server
```

For tunnels that survive laptop sleep AND reboots, use a launchd LaunchAgent on macOS:

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > ~/Library/LaunchAgents/sh.moor.tunnel.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>sh.moor.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>-L</string><string>8080:127.0.0.1:3000</string>
        <string>-o</string><string>ServerAliveInterval=60</string>
        <string>-o</string><string>ServerAliveCountMax=3</string>
        <string>-o</string><string>ExitOnForwardFailure=yes</string>
        <string>your-server</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/moor-tunnel.log</string>
    <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/moor-tunnel.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.moor.tunnel.plist
```

On Linux, use `systemctl --user` with a similar `ssh -N -L ...` unit and `Restart=always`.
