#!/bin/sh
# #80 moor-respawner entrypoint.
#
# Modes:
#   --self-test     verify docker + compose + jq are present, echo
#                   diagnostic env vars.
#   apply           perform the update flow: read context, pull + up
#                   via compose with the digest override, poll
#                   /api/health, write the result marker. On
#                   up/wait/health failure, attempt rollback via
#                   `docker tag <prev_image_id> :latest` +
#                   --pull never override; markers carry
#                   rolled_back | rollback_failed accordingly (#80 PR #5).
#                   Pull failure does NOT trigger rollback (moor was
#                   never replaced).
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

# Tunables. Defaults are the production values; env overrides exist
# so the shell tests can shrink them without forking the script.
# Production never sets these env vars.
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-1}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-60}"
START_DELAY_SECONDS="${START_DELAY_SECONDS:-2}"  # let moor's HTTP response with audit_id flush before we replace it

# Data dir is overridable via MOOR_DATA_DIR for tests only. Production
# always uses /app/data (mounted by moor's apply path). The override
# lets the shell tests run against a tmpdir without touching the host.
DATA_DIR="${MOOR_DATA_DIR:-/app/data}"

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

# --- apply mode ------------------------------------------------------

# Write a result marker atomically: write a temp file, then rename it
# into place. Same-filesystem rename is atomic on Linux; the moor-side
# marker poller never sees a partial file.
#
# Args:
#   $1 audit_id
#   $2 state          success | failed | rolled_back | rollback_failed
#   $3 error_log      may be empty. For rolled_back / rollback_failed
#                     this carries the ORIGINAL apply failure (not
#                     the rollback step details).
#   $4 rollback_error optional. Only set for rollback_failed; captures
#                     the rollback step that failed.
write_marker() {
  audit_id="$1"
  state="$2"
  error_log="$3"
  rollback_error="${4:-}"
  target="$DATA_DIR/.update-result-${audit_id}.json"
  tmp="$target.tmp.$$"
  # jq -n builds JSON with proper escaping. We omit empty string fields
  # so the marker stays compact when there's nothing to say.
  jq -n \
    --argjson audit_id "$audit_id" \
    --arg state "$state" \
    --arg error_log "$error_log" \
    --arg rollback_error "$rollback_error" \
    '{audit_id: $audit_id, state: $state}
      + (if $error_log == "" then {} else {error_log: $error_log} end)
      + (if $rollback_error == "" then {} else {rollback_error: $rollback_error} end)' \
    > "$tmp"
  mv "$tmp" "$target"
}

# Write a file atomically via temp + rename (same as write_marker).
# Used for the rollback override so a respawner crash mid-write can't
# leave a half-written override on disk for the next attempt.
write_file_atomic() {
  path="$1"
  content="$2"
  tmp="$path.tmp.$$"
  printf '%s' "$content" > "$tmp"
  mv "$tmp" "$path"
}

# Self-contained compose invocations. POSIX (and busybox) sh function
# `set --` does NOT propagate the function-local positional params back
# to the caller, so the previous "build argv into $@, then invoke from
# outer scope" pattern silently dropped the -f stack. Each verb gets
# its own helper that builds + consumes argv in one function.

# Run `docker compose ... pull <service>` with the standard -f stack:
#   -f <config_files[0]> ... -f <config_files[N]> -f <extra_override>
# Stdout/stderr passed through to caller's command substitution; exit
# code is docker compose's.
compose_pull_with() {
  cp_override="$1"
  set --
  cp_i=0
  while [ "$cp_i" -lt "$config_count" ]; do
    cp_cf=$(jq -re ".config_files[$cp_i]" "$context_file")
    set -- "$@" -f "$cp_cf"
    cp_i=$((cp_i + 1))
  done
  set -- "$@" -f "$cp_override"
  docker compose --project-directory "$working_dir" "$@" pull "$service" 2>&1
}

# Run `docker compose ... up -d --no-deps --wait --wait-timeout N
# [--pull never] <service>`. extra is appended verbatim BEFORE the
# service name; rollback passes "--pull never", apply passes "".
compose_up_with() {
  cu_override="$1"
  cu_extra="$2"
  set --
  cu_i=0
  while [ "$cu_i" -lt "$config_count" ]; do
    cu_cf=$(jq -re ".config_files[$cu_i]" "$context_file")
    set -- "$@" -f "$cu_cf"
    cu_i=$((cu_i + 1))
  done
  set -- "$@" -f "$cu_override"
  # $cu_extra is intentionally word-split so "--pull never" → 2 args.
  # shellcheck disable=SC2086
  docker compose --project-directory "$working_dir" "$@" up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS" $cu_extra "$service" 2>&1
}

# Attempt rollback after a compose up / wait / health failure.
# Args:
#   $1 audit_id
#   $2 apply_error    the original failure that triggered rollback
#                     (preserved in marker error_log on either outcome)
#   $3 prev_image_id  must be sha256:... non-empty; falls back to
#                     marker `failed` if invalid (can't roll back to nothing)
attempt_rollback() {
  ar_audit_id="$1"
  ar_apply_error="$2"
  ar_prev_image_id="$3"

  case "$ar_prev_image_id" in
    sha256:*) ;;
    *)
      ar_msg="$ar_apply_error || cannot rollback: prev_image_id missing/invalid: '$ar_prev_image_id'"
      echo "[respawner] FAIL: $ar_msg" >&2
      write_marker "$ar_audit_id" "failed" "$ar_msg"
      return 1
      ;;
  esac

  echo "[respawner] rollback 1/4: docker tag $ar_prev_image_id ghcr.io/caiopizzol/moor:latest"
  if ! ar_tag_out=$(docker tag "$ar_prev_image_id" ghcr.io/caiopizzol/moor:latest 2>&1); then
    ar_rb_msg="docker tag failed: $ar_tag_out"
    echo "[respawner] ROLLBACK FAIL: $ar_rb_msg" >&2
    write_marker "$ar_audit_id" "rollback_failed" "$ar_apply_error" "$ar_rb_msg"
    return 1
  fi

  ar_rollback_override="$DATA_DIR/.update-rollback-${ar_audit_id}.yml"
  echo "[respawner] rollback 2/4: writing $ar_rollback_override"
  write_file_atomic "$ar_rollback_override" "services:
  $service:
    image: ghcr.io/caiopizzol/moor:latest
"

  echo "[respawner] rollback 3/4: docker compose up -d --no-deps --wait --wait-timeout $WAIT_TIMEOUT_SECONDS --pull never $service"
  if ! ar_up_out=$(compose_up_with "$ar_rollback_override" "--pull never"); then
    ar_rb_msg="rollback compose up failed: $ar_up_out"
    echo "[respawner] ROLLBACK FAIL: $ar_rb_msg" >&2
    write_marker "$ar_audit_id" "rollback_failed" "$ar_apply_error" "$ar_rb_msg"
    return 1
  fi

  echo "[respawner] rollback 4/4: polling http://$service:3000/api/health for ${HEALTH_TIMEOUT_SECONDS}s"
  ar_elapsed=0
  while [ "$ar_elapsed" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if ar_health_out=$(curl --silent --fail --max-time 5 "http://$service:3000/api/health" 2>&1); then
      echo "[respawner] rollback health passed: $ar_health_out"
      write_marker "$ar_audit_id" "rolled_back" "$ar_apply_error"
      echo "[respawner] ROLLBACK SUCCEEDED audit_id=$ar_audit_id"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
    ar_elapsed=$((ar_elapsed + HEALTH_INTERVAL_SECONDS))
  done

  ar_rb_msg="rollback health check did not pass within ${HEALTH_TIMEOUT_SECONDS}s; last response: $ar_health_out"
  echo "[respawner] ROLLBACK FAIL: $ar_rb_msg" >&2
  write_marker "$ar_audit_id" "rollback_failed" "$ar_apply_error" "$ar_rb_msg"
  return 1
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
    write_marker "$audit_id" "failed" "$msg"
    return 2
  fi
  if [ ! -f "$override_file" ]; then
    msg="missing override file: $override_file"
    echo "[respawner] FAIL: $msg" >&2
    write_marker "$audit_id" "failed" "$msg"
    return 2
  fi

  # Pull context fields one at a time. -r strips JSON quoting on
  # strings; -e returns non-zero if the field is null/missing.
  service=$(jq -re '.service' "$context_file") || { write_marker "$audit_id" "failed" "context missing .service"; return 2; }
  working_dir=$(jq -re '.working_dir' "$context_file") || { write_marker "$audit_id" "failed" "context missing .working_dir"; return 2; }
  target_digest=$(jq -re '.target_digest' "$context_file") || { write_marker "$audit_id" "failed" "context missing .target_digest"; return 2; }
  # prev_image_id may be null in the JSON if moor couldn't inspect
  # itself; -r returns "null", which we'll treat as invalid in
  # attempt_rollback. Don't fail apply here.
  prev_image_id=$(jq -r '.prev_image_id // ""' "$context_file")

  # config_files array → compose -f stack. Used by compose_*_with
  # helpers; cache the count once.
  config_count=$(jq '.config_files | length' "$context_file")

  # Brief sleep so moor's HTTP response carrying audit_id flushes to
  # the client BEFORE we recreate the moor container.
  sleep "$START_DELAY_SECONDS"

  echo "[respawner] apply audit_id=$audit_id service=$service target_digest=$target_digest"
  echo "[respawner] working_dir=$working_dir prev_image_id=${prev_image_id:-<none>}"
  echo "[respawner] config_files count=$config_count override=$override_file"

  # Pull. PULL FAILURE DOES NOT TRIGGER ROLLBACK — moor was never
  # replaced; rollback would be a no-op risk for no benefit. Marker
  # is plain `failed`.
  echo "[respawner] step 1/3: docker compose pull $service"
  if ! pull_out=$(compose_pull_with "$override_file"); then
    msg="compose pull failed: $pull_out"
    echo "[respawner] FAIL: $msg" >&2
    write_marker "$audit_id" "failed" "$msg"
    return 1
  fi

  # Up. Compose may have started swapping containers by the time this
  # returns non-zero; treat as post-replacement → attempt rollback.
  echo "[respawner] step 2/3: docker compose up -d --no-deps --wait --wait-timeout $WAIT_TIMEOUT_SECONDS $service"
  if ! up_out=$(compose_up_with "$override_file" ""); then
    msg="compose up failed: $up_out"
    echo "[respawner] FAIL (will attempt rollback): $msg" >&2
    attempt_rollback "$audit_id" "$msg" "$prev_image_id"
    return $?
  fi

  # Health poll. New moor is up; any failure here = definitive bad
  # boot → attempt rollback.
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

  msg="health check did not pass within ${HEALTH_TIMEOUT_SECONDS}s; last response: ${health_out:-<none>}"
  echo "[respawner] FAIL (will attempt rollback): $msg" >&2
  attempt_rollback "$audit_id" "$msg" "$prev_image_id"
  return $?
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
                  poll /api/health, write a result marker.
                  - success: new image is healthy.
                  - failed:  pull failed before moor was replaced.
                  - rolled_back: up/health failed; rollback to
                    prev_image_id succeeded. error_log carries the
                    original apply failure.
                  - rollback_failed: up/health failed AND rollback also
                    failed. error_log = apply failure; rollback_error =
                    rollback step that failed. Manual recovery needed.

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
