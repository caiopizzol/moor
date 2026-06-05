#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "verify-mcp-config: $*" >&2
  exit 1
}

[[ -f README.md ]] || fail "missing README.md"
[[ -f .claude.json ]] || fail "missing .claude.json"
[[ -f .codex/config.toml ]] || fail "missing .codex/config.toml"

if grep -R "bunx moor\\|npm install moor" .claude.json .codex/config.toml; then
  fail "uses the unrelated unscoped moor package"
fi

grep -q "@moor-sh/mcp" .claude.json || fail "Claude config missing @moor-sh/mcp"
grep -q "@moor-sh/mcp" .codex/config.toml || fail "Codex config missing @moor-sh/mcp"
grep -q "http://127.0.0.1:8080" .claude.json || fail "Claude config missing tunnel URL"
grep -q "http://127.0.0.1:8080" .codex/config.toml || fail "Codex config missing tunnel URL"
grep -q "MOOR_URL" .claude.json || fail "Claude config missing MOOR_URL"
grep -q "MOOR_API_KEY" .claude.json || fail "Claude config missing MOOR_API_KEY"
grep -q "MOOR_URL" .codex/config.toml || fail "Codex config missing MOOR_URL"
grep -q "MOOR_API_KEY" .codex/config.toml || fail "Codex config missing MOOR_API_KEY"
grep -q "<your-api-key>" .claude.json || fail "Claude config missing API key placeholder"
grep -q "<your-api-key>" .codex/config.toml || fail "Codex config missing API key placeholder"

bun -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(".claude.json", "utf8"));
const server = config.mcpServers?.moor;
if (!server) throw new Error("missing mcpServers.moor");
if (server.command !== "bunx") throw new Error("Claude command must be bunx");
if (!Array.isArray(server.args) || server.args[0] !== "@moor-sh/mcp") {
  throw new Error("Claude args must launch @moor-sh/mcp");
}
if (server.env?.MOOR_URL !== "http://127.0.0.1:8080") {
  throw new Error("Claude MOOR_URL must use the tunnel URL");
}
if (server.env?.MOOR_API_KEY !== "<your-api-key>") {
  throw new Error("Claude MOOR_API_KEY must use the placeholder");
}
'

grep -Fq '[mcp_servers.moor]' .codex/config.toml || fail "Codex config missing mcp_servers.moor table"
grep -q '^command = "bunx"$' .codex/config.toml || fail "Codex command must be bunx"
grep -Fq 'args = ["@moor-sh/mcp"]' .codex/config.toml || fail "Codex args must launch @moor-sh/mcp"
grep -Fq '[mcp_servers.moor.env]' .codex/config.toml || fail "Codex config missing env table"
