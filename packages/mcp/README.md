# @moor-sh/mcp

MCP server for [moor](https://github.com/caiopizzol/moor) - lets AI agents (Claude Code, Cursor, etc.) manage your moor projects through standard MCP tools. Talks to moor's HTTP API; no repo clone needed.

Requires [Bun](https://bun.sh) on the machine running the MCP client. `bunx` fetches and runs `@moor-sh/mcp` directly as the client's MCP subprocess.

## Setup

The easiest path is the `moor mcp config` subcommand from [`@moor-sh/cli`](https://www.npmjs.com/package/@moor-sh/cli):

```bash
bunx @moor-sh/cli mcp config --client claude   # or claude-code, codex
```

It prints a config snippet you paste into your MCP client. Or configure manually:

### Claude Code (`~/.claude.json`)

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

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.moor]
command = "bunx"
args = ["@moor-sh/mcp"]

[mcp_servers.moor.env]
MOOR_URL = "http://127.0.0.1:8080"
MOOR_API_KEY = "your-api-key"
```

For a moor on the same machine as the client, change `MOOR_URL` to `http://localhost:3000`.

## SSH tunnel for remote moor

By default moor's admin is bound to `127.0.0.1:3000` on the server. The MCP client connects to whatever `MOOR_URL` resolves to on the client machine, so for a remote moor, open a tunnel from your laptop:

```bash
ssh -fNL 8080:127.0.0.1:3000 your-server
```

`MOOR_URL=http://127.0.0.1:8080` matches the laptop side of that tunnel. The tunnel must stay up while the MCP client is in use. For a tunnel that survives sleep and reboots, see the [self-hosting guide](https://github.com/caiopizzol/moor/blob/main/docs/self-hosting.md#persistent-tunnel).

## API key

`MOOR_API_KEY` grants admin-equivalent control of the moor host. See the [self-hosting guide](https://github.com/caiopizzol/moor/blob/main/docs/self-hosting.md#api-keys) for how to generate, verify, and rotate it.

## Smoke test

Before relying on the integration:

```bash
MOOR_URL=http://127.0.0.1:8080 MOOR_API_KEY=your-api-key bunx @moor-sh/mcp < /dev/null
```

Exit 0 with no output means the MCP connected, authenticated, and shut down cleanly when stdin closed. Any stderr line plus non-zero exit tells you what's wrong:

- `Cannot reach moor at ...` - URL unreachable or tunnel is down.
- `Authentication failed` - `MOOR_API_KEY` doesn't match the server.
- `moor at ... returned 503` - admin password not configured on the moor server.

## Tools

The MCP server exposes:

- `moor_status` - list all projects with status, source, and domain
- `moor_logs` - get recent container logs for a project (with tail length)
- `moor_rebuild` - rebuild a project from source
- `moor_restart` - stop and start a project's container
- `moor_exec` - run a command inside a project's container
- `moor_env_list` - list environment variables for a project
- `moor_env_set` - set environment variables and restart
- `moor_stats` - host CPU / memory / disk / container counts

## Transport

Stdio only. The MCP client launches `bunx @moor-sh/mcp` as a subprocess and talks over stdin/stdout. HTTP transport is [tracked](https://github.com/caiopizzol/moor/issues/17) but not yet shipped.

## Links

- [moor repo](https://github.com/caiopizzol/moor) - main project
- [Self-hosting guide](https://github.com/caiopizzol/moor/blob/main/docs/self-hosting.md) - first boot, API keys, admin domain
- [`@moor-sh/cli`](https://www.npmjs.com/package/@moor-sh/cli) - command-line interface with `moor mcp config` helper

## License

MIT.
