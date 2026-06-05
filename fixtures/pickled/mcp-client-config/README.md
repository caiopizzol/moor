# Moor MCP client config fixture

Create MCP client config files for a remote moor admin reached through an SSH tunnel.

Write:

- `.claude.json`
- `.codex/config.toml`

Use:

- `bunx`
- `@moor-sh/mcp`
- `MOOR_URL=http://127.0.0.1:8080`
- `MOOR_API_KEY=<your-api-key>`

Do not use the unrelated unscoped `moor` package.

