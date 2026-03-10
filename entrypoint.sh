#!/bin/sh
# Fix data directory ownership for mounted volumes
chown -R bun:bun /app/data 2>/dev/null || true

# Run as root — the Docker socket mount already grants root-equivalent
# access, so USER isolation provides no real security benefit here.
exec bun run apps/api/index.ts
