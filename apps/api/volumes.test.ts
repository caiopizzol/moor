import { describe, expect, test } from "bun:test";
import {
  buildDockerName,
  MAX_DOCKER_NAME_LENGTH,
  MAX_VOLUME_NAME_LENGTH,
  validateDockerName,
  validateVolumeName,
  validateVolumeTarget,
} from "./volumes";

describe("validateVolumeName", () => {
  test("accepts simple alphanumeric names", () => {
    expect(validateVolumeName("data")).toBeNull();
    expect(validateVolumeName("pg_data")).toBeNull();
    expect(validateVolumeName("redis-cache")).toBeNull();
    expect(validateVolumeName("a")).toBeNull();
  });

  test("rejects empty and non-string", () => {
    expect(validateVolumeName("")).toContain("required");
    expect(validateVolumeName(null)).toContain("required");
    expect(validateVolumeName(undefined)).toContain("required");
    expect(validateVolumeName(42)).toContain("required");
  });

  test("rejects names that start with a non-alphanumeric", () => {
    expect(validateVolumeName("_data")).toContain("alphanumeric");
    expect(validateVolumeName("-data")).toContain("alphanumeric");
    expect(validateVolumeName(".data")).toContain("alphanumeric");
  });

  test("rejects names containing slashes or whitespace", () => {
    expect(validateVolumeName("a/b")).toContain("alphanumeric");
    expect(validateVolumeName("a b")).toContain("alphanumeric");
  });

  test(`rejects names longer than ${MAX_VOLUME_NAME_LENGTH} chars`, () => {
    const tooLong = "a".repeat(MAX_VOLUME_NAME_LENGTH + 1);
    expect(validateVolumeName(tooLong)).toContain(`<= ${MAX_VOLUME_NAME_LENGTH}`);
    const justRight = "a".repeat(MAX_VOLUME_NAME_LENGTH);
    expect(validateVolumeName(justRight)).toBeNull();
  });
});

describe("validateVolumeTarget", () => {
  test("accepts common absolute paths", () => {
    expect(validateVolumeTarget("/var/lib/postgresql/data")).toBeNull();
    expect(validateVolumeTarget("/data")).toBeNull();
    expect(validateVolumeTarget("/etc/myapp/config")).toBeNull();
  });

  test("rejects non-strings and empty", () => {
    expect(validateVolumeTarget("")).toContain("required");
    expect(validateVolumeTarget(null)).toContain("required");
  });

  test("rejects relative paths", () => {
    expect(validateVolumeTarget("data")).toContain("absolute");
    expect(validateVolumeTarget("./data")).toContain("absolute");
  });

  test("rejects paths containing whitespace", () => {
    expect(validateVolumeTarget("/var/my data")).toContain("whitespace");
    expect(validateVolumeTarget("/var/tab\tdir")).toContain("whitespace");
  });

  test("rejects path traversal via ..", () => {
    expect(validateVolumeTarget("/var/../etc")).toContain("..");
    expect(validateVolumeTarget("/a/b/..")).toContain("..");
  });

  test("rejects root and kernel virtual filesystems", () => {
    expect(validateVolumeTarget("/")).toContain("critical");
    expect(validateVolumeTarget("/proc")).toContain("critical");
    expect(validateVolumeTarget("/sys")).toContain("critical");
    expect(validateVolumeTarget("/dev")).toContain("critical");
  });

  test("rejects paths under /proc, /sys, /dev", () => {
    expect(validateVolumeTarget("/proc/1/comm")).toContain("/proc/");
    expect(validateVolumeTarget("/sys/fs/cgroup")).toContain("/sys/");
    expect(validateVolumeTarget("/dev/null")).toContain("/dev/");
  });

  test("allows mounting under /etc (operator's call)", () => {
    expect(validateVolumeTarget("/etc/myapp")).toBeNull();
  });
});

describe("buildDockerName", () => {
  test("prefixes with moor- and joins project + volume name", () => {
    expect(buildDockerName("my-app", "data")).toBe("moor-my-app-data");
    expect(buildDockerName("p1", "v1")).toBe("moor-p1-v1");
  });
});

describe("validateDockerName", () => {
  test("accepts names within the Docker length limit", () => {
    expect(validateDockerName("moor-app-data")).toBeNull();
    expect(validateDockerName("a".repeat(MAX_DOCKER_NAME_LENGTH))).toBeNull();
  });

  test(`rejects names longer than ${MAX_DOCKER_NAME_LENGTH} chars`, () => {
    const tooLong = "a".repeat(MAX_DOCKER_NAME_LENGTH + 1);
    expect(validateDockerName(tooLong)).toContain(`exceeds ${MAX_DOCKER_NAME_LENGTH}`);
  });
});
