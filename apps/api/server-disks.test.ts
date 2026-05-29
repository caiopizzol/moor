// #137: parseDiskList must report every real filesystem and skip pseudo ones,
// so the Server disk card stops hiding additional data volumes.

process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

// Dynamic import: routes/server pulls in db.ts (side-effect opens the DB), so
// the in-memory path must be set first.
const { parseDiskList, parseMonitoredDisks, parseDfOne, isSafeMonitoredPath } = await import(
  "./routes/server"
);

// `df -B1 --output=source,size,used,pcent,target` shape (bytes), mirroring the
// real host: root + a large data volume + pseudo filesystems + boot.
const DF = `Filesystem      1B-blocks         Used  Use% Mounted on
/dev/sda1    161061273600  16106127360   11% /
/dev/sdb     369435906048 180457364684   49% /mnt/volume-hil-1
tmpfs          4090482688            0    0% /dev/shm
overlay      161061273600  16106127360   11% /var/lib/docker/overlay2/abc/merged
/dev/sda15      264289280       147456    1% /boot/efi`;

describe("parseDiskList", () => {
  test("keeps real /dev block volumes, drops tmpfs/overlay/boot/header", () => {
    const disks = parseDiskList(DF);
    expect(disks.map((d) => d.mount)).toEqual(["/", "/mnt/volume-hil-1"]);
  });

  test("reports per-volume used/total/percent (the hidden data disk shows up)", () => {
    const data = parseDiskList(DF).find((d) => d.mount === "/mnt/volume-hil-1");
    expect(data?.percent).toBe(49);
    expect(data?.total).toContain("GB");
    expect(data?.used).toContain("GB");
  });

  test("empty / header-only input yields no disks", () => {
    expect(parseDiskList("")).toEqual([]);
    expect(parseDiskList("Filesystem 1B-blocks Used Use% Mounted on")).toEqual([]);
  });
});

describe("parseMonitoredDisks (#140)", () => {
  test("parses path|label entries, defaults label to path, skips blanks", () => {
    expect(parseMonitoredDisks("/host/mnt/volume-hil-1|CNPJ data, /host/data , ,")).toEqual([
      { path: "/host/mnt/volume-hil-1", label: "CNPJ data" },
      { path: "/host/data", label: "/host/data" },
    ]);
  });
  test("unset/empty → none", () => {
    expect(parseMonitoredDisks(undefined)).toEqual([]);
    expect(parseMonitoredDisks("")).toEqual([]);
  });
});

describe("parseDfOne (#140)", () => {
  test("parses size/used/pcent body, ignoring the header", () => {
    const raw = "1B-blocks         Used Use%\n369435906048 180457364684  49%";
    expect(parseDfOne(raw)).toEqual({ total: 369435906048, used: 180457364684, percent: 49 });
  });
  test("unmounted / empty → null", () => {
    expect(parseDfOne("")).toBeNull();
    expect(parseDfOne("1B-blocks Used Use%")).toBeNull();
  });
});

describe("isSafeMonitoredPath (#140)", () => {
  test("accepts plain absolute paths", () => {
    expect(isSafeMonitoredPath("/host/mnt/volume-hil-1")).toBe(true);
    expect(isSafeMonitoredPath("/app/data")).toBe(true);
  });
  test("rejects option-shaped, relative, and metacharacter paths", () => {
    expect(isSafeMonitoredPath("-h")).toBe(false); // df flag, not a path
    expect(isSafeMonitoredPath("relative/path")).toBe(false); // not absolute
    expect(isSafeMonitoredPath("/path; rm -rf /")).toBe(false); // injection
    expect(isSafeMonitoredPath("/a $(whoami)")).toBe(false);
    expect(isSafeMonitoredPath("")).toBe(false);
  });
});
