// #54 v1: guarded Docker cleanup. Plan returns reclaim candidates;
// execute re-validates each one against current Docker state and only
// then runs the actual prune / delete. The two operations are stateless:
// the caller passes the candidate list from `plan` back into `execute`
// verbatim, and `execute` ignores every field except the identifiers
// (`category` + `id` where applicable). No plan IDs, no TTLs.

import db from "./db";
import { SOCKET as SOCKET_PATH } from "./docker";
import { parseSystemDf, type SystemDfResponse } from "./server-stats";

const SCOPES = ["build_cache", "dangling_image"] as const;
export type CleanupScope = (typeof SCOPES)[number];

export type PlanCandidate =
  | { category: "build_cache"; reclaimable_bytes: number; label: "caution" }
  | {
      category: "dangling_image";
      id: string;
      reclaimable_bytes: number;
      repo_tags: string[];
      label: "safe";
    };

export type ExecuteCandidate =
  | { category: "build_cache" }
  | { category: "dangling_image"; id: string };

export type ExecuteResult =
  | { category: "build_cache"; reclaimed_bytes: number; error: string | null }
  | { category: "dangling_image"; id: string; reclaimed_bytes: number; error: string | null };

export type PlanResponse = {
  candidates: PlanCandidate[];
  total_reclaimable_bytes: number;
};

export type ExecuteResponse = {
  audit_id: number;
  results: ExecuteResult[];
  total_reclaimed_bytes: number;
};

type ImageSummary = {
  Id: string;
  RepoTags?: string[] | null;
  Size: number;
  SharedSize?: number;
  Containers?: number;
};

/** Reject scope tokens we don't recognize. v1 is build_cache + dangling_image. */
export function validateScope(input: unknown):
  | {
      ok: true;
      value: CleanupScope[];
    }
  | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: [...SCOPES] };
  if (!Array.isArray(input)) return { ok: false, error: "scope must be an array of strings" };
  const out: CleanupScope[] = [];
  for (const item of input) {
    if (typeof item !== "string") return { ok: false, error: "scope items must be strings" };
    if (!(SCOPES as readonly string[]).includes(item)) {
      return {
        ok: false,
        error: `unknown scope "${item}". v1 supports: ${SCOPES.join(", ")}`,
      };
    }
    if (!out.includes(item as CleanupScope)) out.push(item as CleanupScope);
  }
  return { ok: true, value: out.length > 0 ? out : [...SCOPES] };
}

/** Strip caller-supplied metadata down to the identifying fields. The
 *  rest (reclaimable_bytes, repo_tags, label) is computed fresh at
 *  execute time so a stale or fabricated value can't reach the deletion
 *  code. */
export function validateExecuteCandidates(input: unknown):
  | {
      ok: true;
      value: ExecuteCandidate[];
    }
  | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "candidates must be an array" };
  if (input.length === 0) {
    return {
      ok: false,
      error: "candidates must not be empty — call moor_cleanup_plan first, then pass the result",
    };
  }
  const out: ExecuteCandidate[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object")
      return { ok: false, error: "each candidate must be an object" };
    const c = raw as { category?: unknown; id?: unknown };
    if (c.category === "build_cache") {
      out.push({ category: "build_cache" });
      continue;
    }
    if (c.category === "dangling_image") {
      if (typeof c.id !== "string" || c.id.length === 0) {
        return { ok: false, error: "dangling_image candidate requires non-empty id" };
      }
      out.push({ category: "dangling_image", id: c.id });
      continue;
    }
    return {
      ok: false,
      error: `unknown candidate category "${String(c.category)}"`,
    };
  }
  return { ok: true, value: out };
}

/** Aggregate `/system/df` into the single build_cache plan row. Returns
 *  null when there's nothing safely reclaimable, so the plan response
 *  doesn't surface a candidate the caller can't actually act on. */
export function summarizeBuildCachePlan(df: SystemDfResponse): PlanCandidate | null {
  const summary = parseSystemDf(df).build_cache;
  if (summary.reclaimable_bytes <= 0) return null;
  return {
    category: "build_cache",
    reclaimable_bytes: summary.reclaimable_bytes,
    label: "caution",
  };
}

/** Turn the dangling-image listing into per-ID plan candidates, excluding
 *  any image still referenced by a container (running OR stopped).
 *
 *  Production smoke showed that ~5–7% of plan candidates failed with
 *  HTTP 409 "image is being used by stopped container" — Docker refuses
 *  to delete an image whose metadata a stopped container still needs,
 *  unless `force=true` is set (which we deliberately don't use, since
 *  it would silently destroy that stopped-container record too).
 *
 *  `inUseImageIds` is the set of ImageIDs (full `sha256:...`) currently
 *  referenced by any container per `/containers/json?all=true`.
 *  Filtering here makes plan output match what execute can actually
 *  free, instead of surfacing predictable errors in every audit row.
 *  Container creation between plan and execute is still possible — the
 *  rare race-case 409 is handled in `executeDanglingImage`. */
export function summarizeDanglingImagesPlan(
  images: ImageSummary[],
  inUseImageIds: ReadonlySet<string> = new Set(),
): PlanCandidate[] {
  const out: PlanCandidate[] = [];
  for (const img of images) {
    if (inUseImageIds.has(img.Id)) continue;
    const unique = Math.max(0, (img.Size ?? 0) - (img.SharedSize ?? 0));
    if (unique <= 0) continue;
    out.push({
      category: "dangling_image",
      id: img.Id,
      reclaimable_bytes: unique,
      repo_tags: img.RepoTags ?? [],
      label: "safe",
    });
  }
  return out;
}

async function dockerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://localhost${path}`, {
    unix: SOCKET_PATH,
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!res.ok) {
    throw new Error(
      `docker ${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

async function fetchSystemDf(): Promise<SystemDfResponse> {
  return dockerJson<SystemDfResponse>("/v1.44/system/df");
}

async function fetchDanglingImages(): Promise<ImageSummary[]> {
  const q = encodeURIComponent(JSON.stringify({ dangling: ["true"] }));
  return dockerJson<ImageSummary[]>(`/v1.44/images/json?shared-size=true&filters=${q}`);
}

/** Build the set of ImageIDs referenced by *any* container — running or
 *  stopped. Docker's per-image `Containers` count is -1 by default and
 *  requires a separate flag (and even then is inconsistent across
 *  daemon versions), so we enumerate from /containers/json?all=true,
 *  which always populates `ImageID` reliably. */
async function fetchContainerImageIds(): Promise<Set<string>> {
  const containers = await dockerJson<Array<{ ImageID?: string }>>(
    "/v1.44/containers/json?all=true",
  );
  const out = new Set<string>();
  for (const c of containers) {
    if (c.ImageID) out.add(c.ImageID);
  }
  return out;
}

export async function planCleanup(scope: CleanupScope[]): Promise<PlanResponse> {
  const candidates: PlanCandidate[] = [];

  if (scope.includes("build_cache")) {
    const df = await fetchSystemDf();
    const row = summarizeBuildCachePlan(df);
    if (row) candidates.push(row);
  }

  if (scope.includes("dangling_image")) {
    const [images, inUse] = await Promise.all([fetchDanglingImages(), fetchContainerImageIds()]);
    candidates.push(...summarizeDanglingImagesPlan(images, inUse));
  }

  const total_reclaimable_bytes = candidates.reduce((s, c) => s + c.reclaimable_bytes, 0);
  return { candidates, total_reclaimable_bytes };
}

/** Re-validate that an image ID is still in the current dangling set.
 *  Returns the unique reclaimable bytes if eligible, null otherwise. */
async function revalidateDanglingImage(id: string): Promise<number | null> {
  const current = await fetchDanglingImages();
  const match = current.find((img) => img.Id === id);
  if (!match) return null;
  return Math.max(0, (match.Size ?? 0) - (match.SharedSize ?? 0));
}

async function executeBuildCache(): Promise<ExecuteResult> {
  try {
    const res = await dockerJson<{ SpaceReclaimed?: number }>("/v1.44/build/prune", {
      method: "POST",
    });
    return {
      category: "build_cache",
      reclaimed_bytes: res.SpaceReclaimed ?? 0,
      error: null,
    };
  } catch (e) {
    return {
      category: "build_cache",
      reclaimed_bytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeDanglingImage(id: string): Promise<ExecuteResult> {
  try {
    const expected = await revalidateDanglingImage(id);
    if (expected === null) {
      return {
        category: "dangling_image",
        id,
        reclaimed_bytes: 0,
        // Honest "no longer dangling" — the image may have been pulled,
        // tagged, or removed between plan and execute.
        error: "no longer dangling at execute time; skipped",
      };
    }
    // noprune=true is load-bearing. Without it, Docker also removes
    // untagged parent images, which would silently reclaim more than the
    // plan listed and break the "delete exactly the planned IDs" contract.
    const res = await fetch(
      `http://localhost/v1.44/images/${encodeURIComponent(id)}?noprune=true`,
      {
        unix: SOCKET_PATH,
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      // 409 with "being used" is the race case: a container appeared
      // between plan and execute that now references the image (or a
      // stopped container slipped past the plan-time filter). Label it
      // honestly so the audit row distinguishes "container conflict"
      // from real Docker failures.
      if (res.status === 409 && body.includes("is being used")) {
        return {
          category: "dangling_image",
          id,
          reclaimed_bytes: 0,
          error: "referenced by a container at execute time; skipped (use docker rm to unblock)",
        };
      }
      return {
        category: "dangling_image",
        id,
        reclaimed_bytes: 0,
        error: `docker DELETE /images/${id} -> ${res.status}: ${body}`,
      };
    }
    // 404 means it disappeared between revalidate and delete; treat as
    // a no-op rather than failure. The audit row still records the row.
    return {
      category: "dangling_image",
      id,
      reclaimed_bytes: res.status === 404 ? 0 : expected,
      error: null,
    };
  } catch (e) {
    return {
      category: "dangling_image",
      id,
      reclaimed_bytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function executeCleanup(candidates: ExecuteCandidate[]): Promise<ExecuteResponse> {
  const results: ExecuteResult[] = [];

  for (const c of candidates) {
    if (c.category === "build_cache") {
      results.push(await executeBuildCache());
    } else {
      results.push(await executeDanglingImage(c.id));
    }
  }

  const total_reclaimed_bytes = results.reduce((s, r) => s + r.reclaimed_bytes, 0);

  const inserted = db
    .query(
      `INSERT INTO cleanup_audit (candidates_json, results_json, reclaimed_bytes)
       VALUES (?, ?, ?)
       RETURNING id`,
    )
    .get(JSON.stringify(candidates), JSON.stringify(results), total_reclaimed_bytes) as {
    id: number;
  };

  return { audit_id: inserted.id, results, total_reclaimed_bytes };
}
