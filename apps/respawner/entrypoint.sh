#!/bin/sh
# #80 moor-respawner entrypoint.
#
# Modes:
#   --self-test     verify docker + compose + jq are present, echo
#                   diagnostic env vars.
#   apply           perform the update flow: read context, `docker pull`
#                   the target digest, `docker tag` it as
#                   ghcr.io/caiopizzol/moor:latest, then
#                   `docker compose up --pull never` against the
#                   operator's existing -f stack (no moor-generated
#                   override). Poll /api/health, write the result
#                   marker. On up/wait/health failure, attempt rollback
#                   via `docker tag <prev_image_id> :latest` + the same
#                   compose up --pull never. Neither apply nor rollback
#                   appends `-f /app/data/...` to the new container's
#                   config_files label (#105). Pull/tag failure on apply
#                   does NOT trigger rollback (moor was never replaced).
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

# Self-contained compose invocations. POSIX (and busybox) sh function
# `set --` does NOT propagate the function-local positional params back
# to the caller, so the previous "build argv into $@, then invoke from
# outer scope" pattern silently dropped the -f stack. The single helper
# below builds + consumes argv in one function.

# Run `docker compose ... up -d --no-deps --wait --wait-timeout N
# --pull never <service>` with ONLY the operator's -f stack (the
# config_files captured at moor's launch). #105: we used to append
# `-f .update-{override,rollback}-<id>.yml` here, which Compose then
# baked into the new container's `config_files` label permanently,
# poisoning the next moor_update_apply (the #99 validator rejects
# entries outside working_dir). The fix is to never append our own
# `-f` and let the retag handle the image swap: callers pull-and-tag
# the target (apply) or tag prev_image_id (rollback) onto :latest, and
# the operator's compose service definition pulls from local :latest.
compose_up_pull_never() {
  set --
  cu_i=0
  while [ "$cu_i" -lt "$config_count" ]; do
    cu_cf=$(jq -re ".config_files[$cu_i]" "$context_file")
    set -- "$@" -f "$cu_cf"
    cu_i=$((cu_i + 1))
  done
  docker compose --project-directory "$working_dir" "$@" up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT_SECONDS" --pull never "$service" 2>&1
}

# Pull target image by digest and retag local `:latest` to it (#105).
# Both must succeed before we touch compose; either failure → marker
# `failed`, no rollback (moor was never replaced). Echoes a single
# diagnostic line on failure that the caller passes to write_marker.
pull_and_tag_target() {
  pt_ref="ghcr.io/caiopizzol/moor@${target_digest}"
  pt_tag="ghcr.io/caiopizzol/moor:latest"
  if ! pt_pull_out=$(docker pull "$pt_ref" 2>&1); then
    echo "docker pull $pt_ref failed: $pt_pull_out"
    return 1
  fi
  if ! pt_tag_out=$(docker tag "$pt_ref" "$pt_tag" 2>&1); then
    echo "docker tag $pt_ref $pt_tag failed: $pt_tag_out"
    return 1
  fi
  return 0
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

  echo "[respawner] rollback 1/3: docker tag $ar_prev_image_id ghcr.io/caiopizzol/moor:latest"
  if ! ar_tag_out=$(docker tag "$ar_prev_image_id" ghcr.io/caiopizzol/moor:latest 2>&1); then
    ar_rb_msg="docker tag failed: $ar_tag_out"
    echo "[respawner] ROLLBACK FAIL: $ar_rb_msg" >&2
    write_marker "$ar_audit_id" "rollback_failed" "$ar_apply_error" "$ar_rb_msg"
    return 1
  fi

  # #105: no rollback override file. Retagging :latest to prev_image_id
  # above is enough; compose up below uses only the operator's -f stack
  # and `--pull never` so it picks up the now-prev-image-id :latest.
  echo "[respawner] rollback 2/3: docker compose up -d --no-deps --wait --wait-timeout $WAIT_TIMEOUT_SECONDS --pull never $service"
  if ! ar_up_out=$(compose_up_pull_never); then
    ar_rb_msg="rollback compose up failed: $ar_up_out"
    echo "[respawner] ROLLBACK FAIL: $ar_rb_msg" >&2
    write_marker "$ar_audit_id" "rollback_failed" "$ar_apply_error" "$ar_rb_msg"
    return 1
  fi

  echo "[respawner] rollback 3/3: polling http://$service:3000/api/health for ${HEALTH_TIMEOUT_SECONDS}s"
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

  if [ ! -f "$context_file" ]; then
    msg="missing context file: $context_file"
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

  # config_files array → compose -f stack. Used by compose_up_pull_never;
  # cache the count once.
  config_count=$(jq '.config_files | length' "$context_file")

  # Brief sleep so moor's HTTP response carrying audit_id flushes to
  # the client BEFORE we recreate the moor container.
  sleep "$START_DELAY_SECONDS"

  echo "[respawner] apply audit_id=$audit_id service=$service target_digest=$target_digest"
  echo "[respawner] working_dir=$working_dir prev_image_id=${prev_image_id:-<none>}"
  echo "[respawner] config_files count=$config_count"

  # Step 1: docker pull <repo>@<digest> + docker tag <pulled> :latest.
  # PULL/TAG FAILURE DOES NOT TRIGGER ROLLBACK — moor was never
  # replaced; rollback would be a no-op risk for no benefit. Marker
  # is plain `failed`.
  echo "[respawner] step 1/3: docker pull ghcr.io/caiopizzol/moor@${target_digest} + tag :latest"
  if ! pt_out=$(pull_and_tag_target); then
    echo "[respawner] FAIL: $pt_out" >&2
    write_marker "$audit_id" "failed" "$pt_out"
    return 1
  fi

  # Step 2: compose up against operator's existing -f stack, with
  # `--pull never` since we just retagged :latest locally. Compose may
  # have started swapping containers by the time this returns non-zero;
  # treat as post-replacement → attempt rollback.
  echo "[respawner] step 2/3: docker compose up -d --no-deps --wait --wait-timeout $WAIT_TIMEOUT_SECONDS --pull never $service"
  if ! up_out=$(compose_up_pull_never); then
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
                  docker pull the target digest, docker tag it as
                  ghcr.io/caiopizzol/moor:latest, docker compose up
                  --pull never the moor service, poll /api/health,
                  write a result marker. No -f override is appended to
                  the operator's compose stack (#105).
                  - success: new image is healthy.
                  - failed:  pull or tag failed before moor was replaced.
                  - rolled_back: up/health failed; rollback (retag
                    prev_image_id → :latest + compose up --pull never)
                    succeeded. error_log carries the original apply
                    failure.
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
