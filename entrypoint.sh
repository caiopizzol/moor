#!/bin/sh
# Fix data directory ownership for mounted volumes
chown -R bun:bun /app/data 2>/dev/null || true

# Drop to bun user and run the server
exec su -s /bin/sh bun -c "bun run apps/api/index.ts"
