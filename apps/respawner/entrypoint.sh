#!/bin/sh
# #80 PR #3: moor-respawner entrypoint.
#
# PR #3 scope is PACKAGING ONLY. This script implements --self-test;
# the real update / rollback / health-poll / marker-write logic lands
# in PR #4 and PR #5.
#
# Security posture (also on the image LABEL):
# - Transient. moor launches a respawner for a single update window
#   and removes it after the marker is written. There is no daemon.
# - Requires /var/run/docker.sock mounted in. No other privileged
#   access. No open ports. No long-running loop.
# - No code execution from external input. This script is the only
#   code path.

set -eu

print_var() {
  # POSIX-safe indirect var read.
  name="$1"
  eval "val=\${$name:-}"
  if [ -z "$val" ]; then
    echo "[respawner] self-test: $name unset (OK in self-test mode; required for update mode in PR #4)"
  else
    echo "[respawner] self-test: $name=$val"
  fi
}

self_test() {
  echo "[respawner] self-test: checking docker CLI"
  if ! docker version >/dev/null 2>&1; then
    echo "[respawner] FAIL: 'docker version' did not succeed" >&2
    echo "[respawner] hint: respawner must run with -v /var/run/docker.sock:/var/run/docker.sock" >&2
    return 1
  fi
  docker version --format '[respawner] self-test: docker client {{.Client.Version}} / server {{.Server.Version}}'

  echo "[respawner] self-test: checking docker compose plugin"
  if ! docker compose version >/dev/null 2>&1; then
    echo "[respawner] FAIL: 'docker compose version' did not succeed" >&2
    echo "[respawner] hint: docker-cli-compose package missing from the image" >&2
    return 1
  fi
  docker compose version --short | sed 's/^/[respawner] self-test: docker compose /'

  echo "[respawner] self-test: checking env vars that PR #4 will require"
  for name in MOOR_AUDIT_ID MOOR_TARGET_DIGEST MOOR_PREV_IMAGE_ID \
              MOOR_SERVICE MOOR_WORKING_DIR MOOR_CONFIG_FILES \
              MOOR_DATA_MOUNT MOOR_NETWORK; do
    print_var "$name"
  done

  echo "[respawner] self-test PASSED"
  return 0
}

case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
  --help|-h)
    cat <<'USAGE'
moor-respawner — transient updater for moor

Modes:
  --self-test     Verify docker + docker compose are available and
                  print the env vars PR #4 will consume. Exits 0 on
                  success, 1 on docker/compose missing.

  (no args)       Update mode is not implemented in this PR.
                  Coming in PR #4 (apply) and PR #5 (rollback).

Required at runtime:
  -v /var/run/docker.sock:/var/run/docker.sock
USAGE
    exit 0
    ;;
  *)
    echo "[respawner] update mode not implemented yet — PR #3 ships --self-test only." >&2
    echo "[respawner] run with --help for usage." >&2
    exit 2
    ;;
esac
