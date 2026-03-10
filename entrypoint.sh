#!/bin/sh
# Fix data directory ownership for mounted volumes
chown -R bun:bun /app/data 2>/dev/null || true

# Give bun user access to the Docker socket
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  # Add bun to the docker socket's group (create group if needed)
  if ! getent group "$DOCKER_GID" >/dev/null 2>&1; then
    addgroup --gid "$DOCKER_GID" docker 2>/dev/null || true
  fi
  DOCKER_GROUP=$(getent group "$DOCKER_GID" | cut -d: -f1)
  adduser bun "$DOCKER_GROUP" 2>/dev/null || true
fi

# Drop to bun user and run the server
exec su -s /bin/sh bun -c "bun run apps/api/index.ts"
