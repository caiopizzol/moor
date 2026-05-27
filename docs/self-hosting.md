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

## Private registry images

When a project's `docker_image` references a private registry (GHCR, Docker Hub, ECR, a self-hosted Harbor), moor needs credentials to pull. Add one row per registry hostname. The pull path looks up by the hostname extracted from the image ref and attaches `X-Registry-Auth` on `/images/create`. Anonymous pulls keep working for public images: a missing credential means no header, same as today.

The HTTP API requires `MOOR_API_KEY` (see [API keys](#api-keys) above).

### Add a credential

GHCR with a classic PAT (the documented path; scope `read:packages`):

```bash
KEY=$(grep '^MOOR_API_KEY=' .env | cut -d= -f2-)
curl -fsS -X POST http://127.0.0.1:3000/api/server/registry-credentials \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"hostname":"ghcr.io","username":"<your-github-username>","secret":"ghp_..."}'
```

`hostname` must be the bare host as it appears in the image ref: `ghcr.io`, `docker.io`, `localhost:5000`, `registry.example.com:5000`. No scheme, no path. Case is normalized at storage, so `GHCR.IO` and `ghcr.io` resolve to the same row.

### List, rotate, delete

```bash
# List (metadata only - the raw secret is never returned)
curl -fsS -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:3000/api/server/registry-credentials

# Rotate the secret on id=1
curl -fsS -X PUT http://127.0.0.1:3000/api/server/registry-credentials/1 \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"secret":"ghp_NEW"}'

# Delete
curl -fsS -X DELETE http://127.0.0.1:3000/api/server/registry-credentials/1 \
  -H "Authorization: Bearer $KEY"
```

To change a hostname, delete and recreate. The hostname is the lookup key and is not patchable through `PUT`.

MCP equivalents: `moor_registry_credentials_list`, `moor_registry_credential_get`, `moor_registry_credential_add`, `moor_registry_credential_update`, `moor_registry_credential_delete`.

### Storage and reads

Secrets are stored plaintext in moor's SQLite file, matching how `env_vars` are stored. The DB file is the trust boundary. All read paths (HTTP and MCP) return metadata only: `secret` comes back as `{ "configured": true, "kind": "github_classic_pat" | "github_fine_grained_pat" | "unknown" }`. The raw value is never returned by API or MCP read responses. It is still sent outbound to the Docker daemon as `X-Registry-Auth` during pulls, since that is the whole point of storing it.

### Scope

This covers private images referenced as `docker_image` (the pull path through `/images/create`). Private base images inside a Dockerfile build go through a different daemon header (`X-Registry-Config` on `/build`) and are not wired yet.

## Private GitHub repos

For projects whose `github_url` points at a private repo, moor stores an HTTPS PAT per host in a separate table from registry credentials. At build time, moor synthesizes the credentialed clone URL in memory and hands it to the Docker daemon's `remote=` build, then discards it. The credential never lives on the project row, never appears in `github_url`, and is never returned by any API or MCP read.

v1 supports HTTPS PATs only. For GitHub: a fine-grained PAT with `Contents: read` (username `x-access-token`) is the recommended path; classic PATs with `repo` scope also work.

The HTTP API requires `MOOR_API_KEY` (see [API keys](#api-keys) above).

### Add a credential

```bash
KEY=$(grep '^MOOR_API_KEY=' .env | cut -d= -f2-)
curl -fsS -X POST http://127.0.0.1:3000/api/server/source-credentials \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"hostname":"github.com","label":"personal","username":"x-access-token","secret":"github_pat_..."}'
```

`hostname` must be the bare host as parsed from a Git URL: `github.com`, `gitlab.com`, etc. No scheme, no path. Case is normalized at storage. The `(hostname, label)` pair is unique, so multiple credentials per host are fine as long as labels differ (`personal` vs `work-org`, etc.).

### List, rotate, delete

```bash
# List (metadata only, raw secret is never returned)
curl -fsS -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:3000/api/server/source-credentials

# Rotate the secret on id=1
curl -fsS -X PUT http://127.0.0.1:3000/api/server/source-credentials/1 \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"secret":"github_pat_NEW"}'

# Delete (confirm_label must match the row's label)
curl -fsS -X DELETE \
  "http://127.0.0.1:3000/api/server/source-credentials/1?confirm_label=personal" \
  -H "Authorization: Bearer $KEY"
```

To change a hostname, delete and recreate. Hostname is the lookup key and is not patchable through `PUT`. Delete is refused with `credential_in_use` if any project still references the credential.

MCP equivalents: `moor_source_credentials_list`, `moor_source_credential_get`, `moor_source_credential_add`, `moor_source_credential_update`, `moor_source_credential_delete`, `moor_source_credential_check`.

### Canonical agent recipe

The build path is strict about explicit intent: a project row with `source_credential_id` unset means **anonymous clone, no credentials table lookup**. There is no auto-attach. To deploy a private repo, an agent must run `_check` first to discover (or verify) the credential, then pass that id into `moor_deploy` or pin it on the project row.

```
1. moor_source_credential_check({ github_url: "https://github.com/acme/api" })
   → { ok: true, default_branch: "main", auto_selected_credential_id: 1 }   // single matching credential
   → { ok: false, code: "source_credential_required", hostname: "github.com" }  // private, no credential exists for host
   → { ok: false, code: "source_credential_ambiguous", candidates: [...] }    // multiple match, agent picks one
2. moor_deploy({ name: "api", github_url: "...", source_credential_id: 1, ... })
```

`auto_selected_credential_id` only appears in the `_check` response. The build path does not auto-select. An agent that calls `moor_deploy` without `_check` first will get an anonymous clone, which works for public repos and fails with an auth error for private ones.

To attach a credential to an existing project without redeploying, `moor_project_update` accepts `source_credential_id` (pass `null` to detach). The change takes effect on the next build.

### First deploy: env vars and DNS

A private-repo project typically needs env vars before its container will boot. `moor_deploy` exposes an `env_vars` map; pre-populate it on the first call so the container starts cleanly. Adding them after a failed boot works too via `moor_env_set` followed by `moor_restart`.

Deploy without `domain` on the first run unless DNS already points at the moor host. The container will run on its internal port and you can attach a domain in a follow-up `moor_project_update` once the A/AAAA record propagates. Setting `domain` before DNS resolves leaves Caddy unable to issue a certificate.

### Post-deploy confirmation

```
moor_project_get({ id: <id> }) → check live_status: "running"
```

`moor_project_get` reads the project row and reconciles `live_status` against Docker. `moor_status` is the all-projects list tool; use `moor_project_get` for single-project confirmation.

### Rotation and recovery

A credential whose probe failed (expired or revoked PAT) flips to `state: failed` and is rejected at build time with `credential_not_active`. Recovery is two calls:

```
1. moor_source_credential_update({ id: 1, secret: "github_pat_NEW" })
2. moor_source_credential_check({ github_url: "...", source_credential_id: 1 })
   → ok: true → state flips back to active
```

`_check` is the only call that flips state. `_update` alone leaves the credential in whatever state it was in, so existing builds keep rejecting it until `_check` proves the new secret works.

### Storage and reads

Secrets are stored plaintext in moor's SQLite file, matching `env_vars` and registry credentials. All read paths (HTTP and MCP) return metadata only: `secret` comes back as `{ "configured": true, "kind": "github_classic_pat" | "github_fine_grained_pat" | "unknown" }`. The raw value is never returned by API or MCP responses.

Honest trust boundary: the secret transits to the Docker daemon as part of the build `remote=` URL (the daemon clones, not moor). The SQLite file and the Docker socket are the trust boundary; this is not full secret isolation. Anyone with admin access or a valid `MOOR_API_KEY` can rotate, attach, or detach credentials. Build logs are redacted before being persisted or streamed, so embedded `https://user:secret@host` patterns do not appear in `moor_logs` or SSE output.

### Out of scope

The v1 surface is intentionally narrow:

- **SSH deploy keys.** HTTPS PATs cover the same use cases and avoid a second key-management surface.
- **Moor-controlled clone.** The Docker daemon clones via `remote=` so moor never touches the source tarball.
- **Private base images inside the Dockerfile.** Same as the registry section above: `X-Registry-Config` on `/build` is not wired.
- **Submodules, Git LFS, GitHub App tokens.** PATs only.

## Scheduled dangling-image cleanup

Builds create new image layers and leave the previous tagged image as a dangling artifact. On an active host these add up fast (8 GB+ regenerates within minutes when several projects rebuild). The MCP tools `moor_cleanup_plan` + `moor_cleanup_execute` let you reclaim that space manually.

Moor can also run the same cleanup on a schedule. Off by default; opt in via:

```bash
MOOR_CLEANUP_DANGLING_INTERVAL_HOURS=24
```

**Existing installs:** if your `docker-compose.yml` predates this feature, the var also has to be declared in the moor service's `environment` block. Add it next to `MOOR_API_KEY`:

```yaml
services:
  moor:
    environment:
      - MOOR_API_KEY
      - MOOR_CLEANUP_DANGLING_INTERVAL_HOURS
```

Compose only forwards env vars listed there — setting it in `.env` alone is not enough. New installs from the installer get this automatically.

Accepted range: from `0.0167` (1 minute) up to `596` hours (about 24 days — the underlying `setInterval` ms cap). Values outside that range are logged and ignored, and the scheduler stays off.

The scheduler reuses the manual code path — same eligibility filter (`noprune=true`, dangling images only), same `cleanup_audit` rows, same per-candidate re-validation at execute time. If a cleanup cycle is still running when the next tick fires, it's skipped rather than overlapped. Failures are logged but never crash the moor process.

Tagged-but-unused images and volumes are not in scope of this scheduler — those need explicit operator action via the manual tools.

## Scheduled DB backups

Moor's state (projects, env vars, crons, run history) lives in a single SQLite file at `/app/data/moor.db`. Before a manual update — `docker compose pull moor && docker compose up -d --no-deps --wait moor` — take a snapshot so a failed migration or unexpected schema change is recoverable.

Take one on demand from the MCP:

```
moor_db_backup
```

That writes `/app/data/moor.db.backup-<epoch-ms>` via SQLite's `VACUUM INTO` (atomic at the SQLite layer; plain `cp` of the hot WAL DB would copy mid-checkpoint state). After it returns, `moor_update_status` will report `db_backup.age_seconds` close to 0 and `safe_to_update` can flip to `YES` once active work is also zero.

To take snapshots on a schedule instead, opt in via:

```bash
MOOR_DB_BACKUP_INTERVAL_HOURS=24
```

**Existing installs:** as with `MOOR_CLEANUP_DANGLING_INTERVAL_HOURS`, the var also has to be declared in the moor service's `environment` block. Add it next to the cleanup line:

```yaml
services:
  moor:
    environment:
      - MOOR_API_KEY
      - MOOR_CLEANUP_DANGLING_INTERVAL_HOURS
      - MOOR_DB_BACKUP_INTERVAL_HOURS
```

Compose only forwards env vars listed there — setting it in `.env` alone is not enough. New installs from the installer get this automatically.

Accepted range and out-of-range handling are the same as the cleanup scheduler. Retention keeps the 7 most recent snapshots; older ones are pruned at the end of each cycle.

Restore (if ever needed): stop moor, replace `/app/data/moor.db` with a snapshot file, start moor again. Restore tooling beyond that is out of scope for now.

## Self-update and Compose override files

`moor_update_apply` replays Compose commands inside a transient respawner container with the operator's compose `working_dir` bind-mounted **read-only at the same absolute path**. Any `-f` override file used at `docker compose up` time is recorded in Compose's `com.docker.compose.project.config_files` label, and the respawner reads that label to reproduce the same `-f` stack.

The respawner itself never adds an `-f` to that stack. It pulls the target image by digest, retags `ghcr.io/caiopizzol/moor:latest` to point at the pulled image, and runs `docker compose up --pull never` against the operator's existing `-f` stack only. Rollback uses the same shape (retag `prev_image_id` to `:latest`, then `compose up --pull never`). So nothing moor does pollutes the next container's `config_files` label, and your local `:latest` tag always reflects the running version (a plain `docker compose up -d --no-deps --force-recreate moor` will not silently downgrade you).

**Safe**: pinning via `image:` in `docker-compose.yml` itself, or via an override file kept **inside the moor install directory** (e.g. `docker-compose.override.yml` alongside the main file). The respawner can read these because they're under `working_dir`.

**Unsafe**: ad-hoc host-only overrides like `docker compose -f docker-compose.yml -f /tmp/pin.yml up`. The `/tmp/pin.yml` path is invisible to the respawner. moor catches this before launching the respawner and refuses with a `context_failed` error pointing at the offending entry, so you'll see the message in `moor_update_apply`'s response — but the fix is to recreate moor without the override:

```bash
docker compose up -d --force-recreate moor
```

(Without any extra `-f`, just whatever lives under the install dir.) After that, the label resets to just the in-repo compose files and `moor_update_apply` works.

### Recovering from label pollution left by earlier versions

moor versions before this fix (see #105) wrote a `/app/data/.update-override-<id>.yml` file and passed it as `-f` to `docker compose up` during self-update. Compose then baked that path into the new container's `config_files` label. After enough updates the label looked like `…docker-compose.yml,/app/data/.update-override-2.yml,/app/data/.update-override-4.yml,…`, all pointing at paths outside `working_dir`. The first `moor_update_apply` you run on a moor that was previously updated by an older version will refuse with `context_failed` for exactly that reason — moor catching its own past pollution, not yours.

Recovery is the same one-liner as for any unsafe override:

```bash
docker compose up -d --no-deps --force-recreate moor
```

(Run from the moor install directory, with no extra `-f`.) Compose recreates the moor container using only your in-repo compose files; the label resets; subsequent `moor_update_apply` calls work normally and never re-introduce the bad entries.

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
