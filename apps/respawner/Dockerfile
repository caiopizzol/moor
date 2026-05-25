# syntax=docker/dockerfile:1
#
# #80: moor-respawner image. Tagged together with moor itself by the
# existing release-moor.yml so the respawner version always matches
# the moor version that launched it (the contract is between them).
#
# Entrypoint modes (see entrypoint.sh for details):
# - --self-test : verify docker + compose + jq (CI / smoke check).
# - apply       : PR #4 happy path — pull + up + health-poll + marker.
#                 NO rollback in PR #4; PR #5 adds it.
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
# curl: /api/health poll after `compose up`.
# jq: parse the structured update-context JSON moor writes for us
#     (#80 PR #4). Single jq invocations per field; never `eval` jq
#     output.
# (No bash — entrypoint is POSIX sh, runs under Alpine's busybox sh.)
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    curl \
    jq

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

LABEL org.opencontainers.image.source="https://github.com/caiopizzol/moor"
LABEL org.opencontainers.image.description="Transient updater for moor. Requires /var/run/docker.sock. Launched by moor for a single update window then removed."
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/entrypoint.sh"]
