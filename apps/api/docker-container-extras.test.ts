// Tests for the declarative container extras: command/entrypoint overrides and
// file injection. Two layers:
//   - buildContainerCreateBody (pure): Cmd/Entrypoint appear ONLY when set, and
//     are absent otherwise so the image default is preserved.
//   - createAndStartContainer (injected DockerFetch): the file archive PUT lands
//     BEFORE the container start, carries the right tar mode, and is skipped
//     entirely when no files are configured.
// Mirrors the injectable-fetch style of docker-start-cleanup.test.ts. HOSTNAME
// is forced empty so getComposeProject() throws and the network-attach path
// short-circuits without touching a real Docker socket (the module dockerFetch
// is never reached — every call in these flows goes through the injected fetch).

process.env.MOOR_DB_PATH = ":memory:";
process.env.HOSTNAME = "";

import { describe, expect, test } from "bun:test";
import type { ResolvedFile } from "./container-config";

const { buildContainerCreateBody, createAndStartContainer } = await import("./docker");

const IMAGE = "cloudflare/cloudflared:latest";

// --- buildContainerCreateBody: Cmd/Entrypoint presence ---

describe("buildContainerCreateBody — command/entrypoint only when set", () => {
  const base = { imageTag: IMAGE, envVars: [] as { key: string; value: string }[] };

  test("no command/entrypoint → neither key present (image default preserved)", () => {
    const body = buildContainerCreateBody(base);
    expect("Cmd" in body).toBe(false);
    expect("Entrypoint" in body).toBe(false);
  });

  test("command set → Cmd present; entrypoint still absent", () => {
    const body = buildContainerCreateBody({ ...base, command: ["tunnel", "run"] });
    expect(body.Cmd).toEqual(["tunnel", "run"]);
    expect("Entrypoint" in body).toBe(false);
  });

  test("entrypoint set → Entrypoint present", () => {
    const body = buildContainerCreateBody({ ...base, entrypoint: ["/bin/tini", "--"] });
    expect(body.Entrypoint).toEqual(["/bin/tini", "--"]);
  });

  test("both set → both present", () => {
    const body = buildContainerCreateBody({
      ...base,
      command: ["serve"],
      entrypoint: ["/entry.sh"],
    });
    expect(body.Cmd).toEqual(["serve"]);
    expect(body.Entrypoint).toEqual(["/entry.sh"]);
  });

  test("null command/entrypoint → treated as unset (no keys)", () => {
    const body = buildContainerCreateBody({ ...base, command: null, entrypoint: null });
    expect("Cmd" in body).toBe(false);
    expect("Entrypoint" in body).toBe(false);
  });

  test("empty-array command/entrypoint → NOT emitted (would clear image default)", () => {
    // An empty Cmd/Entrypoint tells Docker to clear the image default; absence
    // of input must never do that, so empty arrays are dropped here too.
    const body = buildContainerCreateBody({ ...base, command: [], entrypoint: [] });
    expect("Cmd" in body).toBe(false);
    expect("Entrypoint" in body).toBe(false);
  });
});

// --- createAndStartContainer: ordering + tar mode via injected fetch ---

type Call = { method: string; path: string; body?: unknown };

/** Record every Docker call and return synthetic OK responses. create yields a
 *  fake Id; everything else (delete-existing, archive PUT, start) is a bare 200. */
function recordingFetch(): { calls: Call[]; fetchImpl: import("./docker").DockerFetch } {
  const calls: Call[] = [];
  const fetchImpl: import("./docker").DockerFetch = async (path, opts) => {
    calls.push({ method: opts?.method ?? "GET", path, body: opts?.body });
    if (path.includes("/containers/create")) {
      return new Response(JSON.stringify({ Id: "container0001" }), { status: 201 });
    }
    return new Response("", { status: 200 });
  };
  return { calls, fetchImpl };
}

/** Read a NUL-terminated fixed-width field out of a tar header block. */
function tarField(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  while (end < offset + len && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.slice(offset, end));
}

describe("createAndStartContainer — file injection ordering and mode", () => {
  test("archive PUT happens BEFORE container start, with the file's mode in the tar header", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const files: ResolvedFile[] = [
      { path: "/etc/ssl/tunnel.pem", content: "CERTDATA", mode: 0o600 },
    ];

    const id = await createAndStartContainer(
      IMAGE,
      "moor-tunnel",
      [{ key: "TUNNEL_TOKEN", value: "secret" }],
      [],
      "unless-stopped",
      {},
      [],
      {},
      { command: ["tunnel", "run"], files },
      fetchImpl,
    );
    expect(id).toBe("container0001");

    const archiveIdx = calls.findIndex((c) => c.method === "PUT" && c.path.includes("/archive"));
    const startIdx = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/start"));
    const createIdx = calls.findIndex((c) => c.path.includes("/containers/create"));

    expect(archiveIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // The whole point: files are written into the created container before it
    // boots, so the process sees them on start.
    expect(createIdx).toBeLessThan(archiveIdx);
    expect(archiveIdx).toBeLessThan(startIdx);

    // The PUT body is the tar; first header block carries name + mode.
    const tar = calls[archiveIdx].body as Uint8Array;
    expect(tar).toBeInstanceOf(Uint8Array);
    expect(tarField(tar, 0, 100)).toBe("etc/ssl/tunnel.pem"); // leading slash stripped
    expect(Number.parseInt(tarField(tar, 100, 8), 8)).toBe(0o600);
  });

  test("Cmd is in the create body when command set, and the archive carries every file", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const files: ResolvedFile[] = [
      { path: "/a.conf", content: "A", mode: 0o644 },
      { path: "/b.key", content: "B", mode: 0o600 },
    ];
    await createAndStartContainer(
      IMAGE,
      "moor-multi",
      [],
      [],
      "unless-stopped",
      {},
      [],
      {},
      { command: ["run"], files },
      fetchImpl,
    );

    const createCall = calls.find((c) => c.path.includes("/containers/create"));
    const createBody = JSON.parse(createCall?.body as string) as { Cmd?: string[] };
    expect(createBody.Cmd).toEqual(["run"]);

    // A single archive PUT carries both files (two header+body pairs).
    const archive = calls.filter((c) => c.method === "PUT" && c.path.includes("/archive"));
    expect(archive).toHaveLength(1);
    const tar = archive[0].body as Uint8Array;
    expect(tarField(tar, 0, 100)).toBe("a.conf");
    expect(Number.parseInt(tarField(tar, 100, 8), 8)).toBe(0o644);
  });

  test("no files and no command → no archive PUT, and create body omits Cmd/Entrypoint", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await createAndStartContainer(
      IMAGE,
      "moor-plain",
      [],
      [],
      "unless-stopped",
      {},
      [],
      {},
      {},
      fetchImpl,
    );

    // Behavior for projects that set neither must be unchanged: no injection.
    expect(calls.some((c) => c.path.includes("/archive"))).toBe(false);
    // But the container is still created and started.
    expect(calls.some((c) => c.path.includes("/containers/create"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/start"))).toBe(true);

    const createCall = calls.find((c) => c.path.includes("/containers/create"));
    const createBody = JSON.parse(createCall?.body as string) as Record<string, unknown>;
    expect("Cmd" in createBody).toBe(false);
    expect("Entrypoint" in createBody).toBe(false);
  });

  test("empty files array → no archive PUT (same as unset)", async () => {
    const { calls, fetchImpl } = recordingFetch();
    await createAndStartContainer(
      IMAGE,
      "moor-emptyfiles",
      [],
      [],
      "unless-stopped",
      {},
      [],
      {},
      { files: [] },
      fetchImpl,
    );
    expect(calls.some((c) => c.path.includes("/archive"))).toBe(false);
  });
});
