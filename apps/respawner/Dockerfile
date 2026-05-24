# syntax=docker/dockerfile:1
#
# #80 PR #3: moor-respawner image. Packaging only — the entrypoint
# script implements --self-test in this PR; the real update/rollback
# flow lands in PR #4/#5. Tagged together with moor itself by the
# existing release-moor.yml so respawner version always matches the
# moor version that launched it.
#
# Security posture (also documented in the entrypoint script):
# - Transient: launched by moor for a single update window, removed
#   after the marker is written.
# - Requires /var/run/docker.sock mounted in. No other privileged
#   access. No daemon. No open ports. No long-running loop.
# - No code execution from external input. The entrypoint is the
#   only code path.

FROM alpine:3.20

# docker-cli: issue `docker` commands against the mounted socket.
# docker-cli-compose: `docker compose pull/up --wait` plugin.
# curl: the /api/health poll in PR #4.
# (No bash — entrypoint is POSIX sh, runs under Alpine's busybox sh.)
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    curl

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

LABEL org.opencontainers.image.source="https://github.com/caiopizzol/moor"
LABEL org.opencontainers.image.description="Transient updater for moor. Requires /var/run/docker.sock. Launched by moor for a single update window then removed."
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/entrypoint.sh"]
