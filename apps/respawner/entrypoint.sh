#!/bin/sh
# #80 moor-respawner entrypoint.
#
# Modes:
#   --self-test     verify docker + compose + jq are present, echo
#                   diagnostic env vars. PR #3.
#   apply           perform the happy-path update flow: read context,
#                   pull + up via compose with the digest override,
#                   poll /api/health, write success/failed marker.
#                   PR #4 — NO ROLLBACK; that lands in PR #5.
#   --help          usage.
#
# Security posture (also on the image LABEL):
# - Transient. moor launches a respawner for a single update window
#   and removes it after the marker is written. There is no daemon.
# - Requires /var/run/docker.sock mounted in. No other privileged
#   access. No open ports. No long-running loop.
# - No code execution from external input. This script is the only
#   code path. JSON context is parsed via per-field jq invocations;
#   docker compose argv is built via `set --` so config_files entries
#   with spaces never get re-split.

set -eu

# Tunables that PR #5 will reuse on rollback.
HEALTH_TIMEOUT_SECONDS=60
HEALTH_INTERVAL_SECONDS=1
WAIT_TIMEOUT_SECONDS=60
START_DELAY_SECONDS=2  # let moor's HTTP response with audit_id flush before we replace it

DATA_DIR=/app/data

# --- self-test -------------------------------------------------------

print_var() {
  name="$1"
  eval "val=\${$name:-}"
  if [ -z "$val" ]; then
    echo "[respawner] self-test: $name unset (OK in self-test mode; required for apply mode)"
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

  echo "[respawner] self-test: checking jq"
  if ! jq --version >/dev/null 2>&1; then
    echo "[respawner] FAIL: jq not present in image (required for apply mode context parsing)" >&2
    return 1
  fi
  jq --version | sed 's/^/[respawner] self-test: /'

  echo "[respawner] self-test: env vars used in apply mode"
  for name in MOOR_AUDIT_ID; do
    print_var "$name"
  done

  echo "[respawner] self-test PASSED"
  return 0
}

# --- apply mode (PR #4: NO ROLLBACK) ---------------------------------

# Write a result marker atomically: write a temp file, then rename it
# into place. Same-filesystem rename is atomic on Linux; the moor-side
# marker poller never sees a partial file.
write_marker() {
  audit_id="$1"
  state="$2"          # success | failed
  error_log="$3"      # may be empty
  target="$DATA_DIR/.update-result-${audit_id}.json"
  tmp="$target.tmp.$$"
  # Build JSON via jq -n so error_log gets proper escaping.
  jq -n \
    --argjson audit_id "$audit_id" \
    --arg state "$state" \
    --arg error_log "$error_log" \
    '{audit_id: $audit_id, state: $state} + (if $error_log == "" then {} else {error_log: $error_log} end)' \
    > "$tmp"
  mv "$tmp" "$target"
}

# Run a command but capture stdout + stderr into a variable so a
# failure can be surfaced in the marker's error_log. Returns the
# command's exit code.
run_capture() {
  capture_out=$("$@" 2>&1) || return $?
  return 0
}

apply_mode() {
  audit_id="${MOOR_AUDIT_ID:-}"
  if [ -z "$audit_id" ]; then
    echo "[respawner] FAIL: MOOR_AUDIT_ID env var unset" >&2
    return 2
  fi

  context_file="$DATA_DIR/.update-context-${audit_id}.json"
  override_file="$DATA_DIR/.update-override-${audit_id}.yml"

  if [ ! -f "$context_file" ]; then
    msg="missing context file: $context_file"
    echo "[respawner] FAIL: $msg" >&2
    # Can't write a marker for an audit we don't trust, but the marker
    # uses just audit_id which we have. The new moor will ingest.
    write_marker "$audit_id" "failed" "$msg"
    return 2
  fi
  if [ ! -f "$override_file" ]; then
    msg="missing override file: $override_file"
    echo "[respawner] FAIL: $msg" >&2
    write_marker "$audit_id" "failed" "$msg"
    return 2
  fi

  # Pull the context fields one at a time. -r strips JSON quoting on
  # strings; -e returns non-zero if the field is null/missing.
  service=$(jq -re '.service' "$context_file") || { write_marker "$audit_id" "failed" "context missing .service"; return 2; }
  working_dir=$(jq -re '.working_dir' "$context_file") || { write_marker "$audit_id" "failed" "context missing .working_dir"; return 2; }
  target_digest=$(jq -re '.target_digest' "$context_file") || { write_marker "$audit_id" "failed" "context missing .target_digest"; return 2; }

  # config_files is an array; build argv safely via set -- so entries
  # with spaces / unusual chars never get word-split.
  set --
  # shellcheck disable=SC2046  # we WANT word splitting only on our null-delimited reader
  config_count=$(jq '.config_files | length' "$context_file")
  i=0
  while [ "$i" -lt "$config_count" ]; do
    cf=$(jq -re ".config_files[$i]" "$context_file")
    set -- "$@" -f "$cf"
    i=$((i + 1))
  done
  # Append the override file last so it wins on conflicts.
  set -- "$@" -f "$override_file"

  # Brief sleep so moor's HTTP response carrying audit_id flushes to
  # the client BEFORE we recreate the moor container.
  sleep "$START_DELAY_SECONDS"

  echo "[respawner] apply audit_id=$audit_id service=$service target_digest=$target_digest"
  echo "[respawner] working_dir=$working_dir"
  echo "[respawner] compose -f args: $*"

  # Pull (same -f stack so the override pins the digest).
  echo "[respawner] step 1/3: docker compose pull $service"
  if ! pull_out=$(docker compose --project-directory "$working_dir" "$@" pull "$service" 2>&1); then
    msg="compose pull failed: $pull_out"
    echo "[respawner] FAIL: $msg" >&2
    write_marker "$audit_id" "failed" "$msg"
    return 1
  fi

  # Up — recreates moor with the override-pinned digest, blocks on
  # healthcheck, then we still poll /api/health explicitly for
  # belt-and-suspenders.
  echo "[respawner] step 2/3: docker compose up -d --no-deps --wait --wait-timeout $WAIT_TIMEOUT_SECONDS $service"
  if ! up_out=$(docker compose --project-directory "$working_dir" "$@" up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS" "$service" 2>&1); then
    msg="compose up failed: $up_out"
    echo "[respawner] FAIL: $msg" >&2
    write_marker "$audit_id" "failed" "$msg"
    return 1
  fi

  # Health poll on the compose service DNS name — we attached to the
  # default network at launch.
  echo "[respawner] step 3/3: polling http://$service:3000/api/health for ${HEALTH_TIMEOUT_SECONDS}s"
  elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if health_out=$(curl --silent --fail --max-time 5 "http://$service:3000/api/health" 2>&1); then
      echo "[respawner] health passed: $health_out"
      write_marker "$audit_id" "success" ""
      echo "[respawner] apply SUCCEEDED audit_id=$audit_id"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
    elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
  done

  msg="health check did not pass within ${HEALTH_TIMEOUT_SECONDS}s; last response: $health_out"
  echo "[respawner] FAIL: $msg" >&2
  # PR #4 has NO rollback — we just record failure and exit. PR #5 adds
  # automatic rollback via image retag + --pull never override.
  write_marker "$audit_id" "failed" "$msg"
  return 1
}

# --- dispatch --------------------------------------------------------

case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
  apply)
    apply_mode
    exit $?
    ;;
  --help|-h)
    cat <<'USAGE'
moor-respawner — transient updater for moor

Modes:
  --self-test     Verify docker + docker compose + jq are available and
                  print the env vars apply mode consumes. Exits 0 on
                  success, 1 on a missing dependency.

  apply           Read /app/data/.update-context-<MOOR_AUDIT_ID>.json,
                  pull + up the moor service with the digest override,
                  poll /api/health, write a result marker. NO ROLLBACK
                  in this PR (#80 PR #4); recovery is manual or via
                  the 30-min stale-in_progress sweep.

  (other)         Unknown mode — exit 2.

Required at runtime:
  -v /var/run/docker.sock:/var/run/docker.sock
  -e MOOR_AUDIT_ID=<n>             (apply mode)
  Compose working_dir bind-mounted at the SAME absolute host path.
  /app/data shared with the moor container.
USAGE
    exit 0
    ;;
  *)
    echo "[respawner] unknown mode: ${1:-}" >&2
    echo "[respawner] run with --help for usage." >&2
    exit 2
    ;;
esac
