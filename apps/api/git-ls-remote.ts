// Low-level git ls-remote wrapper used by source-check.ts.
//
// Two responsibilities:
//   - runGitLsRemote: spawn `git ls-remote --symref <url> <ref>` with
//     askpass + GIT_TOKEN env plumbing for HTTPS PATs. Always sets
//     GIT_TERMINAL_PROMPT=0 so prompts fail fast. Output bounded
//     (stdout + stderr both capped). Cleanup runs in finally.
//
//   - parseLsRemoteOutput: pure helper that interprets stdout from
//     `--symref HEAD` or a specific ref query, plus stderr patterns
//     for the documented failure modes.
//
// Secrets are NEVER passed via command-line arguments (visible in `ps`).
// HTTPS PATs go through GIT_ASKPASS + GIT_USERNAME/GIT_TOKEN env. The
// askpass script body is fully static; no shell interpolation of any
// user-supplied input.
//
// v1 is HTTPS PAT only. SSH transport may be added later.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const STDERR_CAP_BYTES = 8 * 1024;
const STDOUT_CAP_BYTES = 64 * 1024;

export type LsRemoteCredential = { username: string; secret: string };

export type LsRemoteRequest = {
  url: string;
  /** Specific ref to query. Omit for `HEAD` (default branch discovery). */
  ref?: string;
  credential?: LsRemoteCredential | null;
  timeoutMs?: number;
};

export type LsRemoteRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ParsedLsRemote =
  | { ok: true; default_branch?: string; head_sha?: string; ref_sha?: string }
  | {
      ok: false;
      code:
        | "clone_auth_failed"
        | "repo_not_found_or_not_scoped"
        | "branch_not_found"
        | "network_unreachable"
        | "source_access_denied_or_not_found"
        | "git_error";
    };

export async function runGitLsRemote(req: LsRemoteRequest): Promise<LsRemoteRunResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "moor-lsremote-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    if (req.credential) {
      const askpassPath = join(tempDir, "askpass.sh");
      writeFileSync(
        askpassPath,
        `#!/bin/sh
case "$1" in
  Username*) printf "%s" "$GIT_USERNAME" ;;
  Password*) printf "%s" "$GIT_TOKEN" ;;
esac
`,
        { mode: 0o700 },
      );
      env.GIT_ASKPASS = askpassPath;
      env.GIT_USERNAME = req.credential.username;
      env.GIT_TOKEN = req.credential.secret;
    }

    // Always pass an explicit ref. Without one, `git ls-remote --symref <url>`
    // dumps every ref and tag - unbounded stdout on large repos.
    const args = ["ls-remote", "--symref", req.url, req.ref ?? "HEAD"];

    return await new Promise<LsRemoteRunResult>((resolve) => {
      const child = spawn("git", args, { env });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= STDOUT_CAP_BYTES) return;
        const room = STDOUT_CAP_BYTES - stdoutBytes;
        const slice = chunk.subarray(0, room);
        stdout += slice.toString("utf8");
        stdoutBytes += slice.length;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= STDERR_CAP_BYTES) return;
        const room = STDERR_CAP_BYTES - stderrBytes;
        const slice = chunk.subarray(0, room);
        stderr += slice.toString("utf8");
        stderrBytes += slice.length;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (req.credential) {
          const tok = req.credential.secret;
          if (tok && stdout.includes(tok)) stdout = stdout.split(tok).join("[REDACTED]");
          if (tok && stderr.includes(tok)) stderr = stderr.split(tok).join("[REDACTED]");
        }
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout: "", stderr: err.message, timedOut: false });
      });
    });
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

export function parseLsRemoteOutput(
  run: LsRemoteRunResult,
  options: { ref?: string; hasCredential: boolean },
): ParsedLsRemote {
  if (run.timedOut) return { ok: false, code: "network_unreachable" };

  const stderrLc = run.stderr.toLowerCase();

  if (run.exitCode === 0) {
    const symrefMatch = run.stdout.match(/^ref: (refs\/heads\/\S+)\s+HEAD/m);
    let default_branch: string | undefined;
    if (symrefMatch) default_branch = symrefMatch[1].replace(/^refs\/heads\//, "");

    const headShaMatch = run.stdout.match(/^([0-9a-f]{40,64})\s+HEAD/m);
    const head_sha = headShaMatch?.[1];

    if (options.ref) {
      const refEsc = options.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refMatch = run.stdout.match(new RegExp(`^([0-9a-f]{40,64})\\s+${refEsc}`, "m"));
      if (!refMatch && !head_sha && !default_branch) {
        return { ok: false, code: "branch_not_found" };
      }
      const ref_sha = refMatch?.[1];
      return { ok: true, default_branch, head_sha, ref_sha };
    }

    return { ok: true, default_branch, head_sha };
  }

  if (
    /could not resolve host|name resolution|no route to host|connection refused|operation timed out/i.test(
      stderrLc,
    )
  ) {
    return { ok: false, code: "network_unreachable" };
  }
  if (
    /authentication failed|invalid username or password|terminal prompts disabled|could not read username|fatal: authentication/i.test(
      stderrLc,
    )
  ) {
    return {
      ok: false,
      code: options.hasCredential ? "clone_auth_failed" : "source_access_denied_or_not_found",
    };
  }
  if (/repository not found|repository.*does not exist|not found/i.test(stderrLc)) {
    return {
      ok: false,
      code: options.hasCredential
        ? "repo_not_found_or_not_scoped"
        : "source_access_denied_or_not_found",
    };
  }
  if (/permission denied|access denied|forbidden/i.test(stderrLc)) {
    return {
      ok: false,
      code: options.hasCredential ? "clone_auth_failed" : "source_access_denied_or_not_found",
    };
  }
  return { ok: false, code: "git_error" };
}
