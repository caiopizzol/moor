import { describe, expect, test } from "bun:test";
import { getHostInfo, hostTotalMemoryMb } from "./host-info";
import {
  MIN_CPUS,
  MIN_MEMORY_LIMIT_MB,
  validateCpus,
  validateMemoryLimitMb,
} from "./resource-limits";

const hostMb = hostTotalMemoryMb();
const hostCores = getHostInfo().cpuCores;

describe("validateMemoryLimitMb", () => {
  test("null and undefined pass (unbounded)", () => {
    expect(validateMemoryLimitMb(null)).toBeNull();
    expect(validateMemoryLimitMb(undefined)).toBeNull();
  });

  test("rejects non-integers", () => {
    expect(validateMemoryLimitMb("512")).toContain("integer");
    expect(validateMemoryLimitMb(512.5)).toContain("integer");
    expect(validateMemoryLimitMb(true)).toContain("integer");
  });

  test(`rejects values below the ${MIN_MEMORY_LIMIT_MB} MB floor`, () => {
    expect(validateMemoryLimitMb(MIN_MEMORY_LIMIT_MB - 1)).toContain(`>= ${MIN_MEMORY_LIMIT_MB}`);
    expect(validateMemoryLimitMb(0)).toContain(`>= ${MIN_MEMORY_LIMIT_MB}`);
    expect(validateMemoryLimitMb(-1)).toContain(`>= ${MIN_MEMORY_LIMIT_MB}`);
  });

  test("accepts the minimum and a typical small value", () => {
    expect(validateMemoryLimitMb(MIN_MEMORY_LIMIT_MB)).toBeNull();
    expect(validateMemoryLimitMb(128)).toBeNull();
  });

  test("rejects values above host total memory", () => {
    if (hostMb > 0) {
      const err = validateMemoryLimitMb(hostMb + 1);
      expect(err).toContain("exceeds host total memory");
    }
  });
});

describe("validateCpus", () => {
  test("null and undefined pass (unbounded)", () => {
    expect(validateCpus(null)).toBeNull();
    expect(validateCpus(undefined)).toBeNull();
  });

  test("rejects non-numbers and non-finite values", () => {
    expect(validateCpus("0.5")).toContain("number");
    expect(validateCpus(Number.POSITIVE_INFINITY)).toContain("number");
    expect(validateCpus(Number.NaN)).toContain("number");
  });

  test("rejects 0 and negatives (null is the clear signal)", () => {
    expect(validateCpus(0)).toContain("> 0");
    expect(validateCpus(-1)).toContain("> 0");
  });

  test(`rejects positive values below ${MIN_CPUS} (would round to NanoCpus=0, Docker reads as unlimited)`, () => {
    // Math.round(0.0001 * 1e9) = 100000 ≠ 0, but it's below our floor — we
    // reject conservatively to avoid the surprising "tiny cpus = unlimited"
    // edge near the rounding boundary.
    expect(validateCpus(0.0005)).toContain(`>= ${MIN_CPUS}`);
    expect(validateCpus(1e-9)).toContain(`>= ${MIN_CPUS}`);
    // And the value that actually rounds to zero is rejected
    expect(Math.round(1e-10 * 1e9)).toBe(0); // sanity: this WOULD become NanoCpus=0
    expect(validateCpus(1e-10)).toContain(`>= ${MIN_CPUS}`);
  });

  test("accepts fractional and integer values at or above the floor", () => {
    expect(validateCpus(MIN_CPUS)).toBeNull();
    expect(validateCpus(0.5)).toBeNull();
    expect(validateCpus(1)).toBeNull();
    expect(validateCpus(2.5)).toBeNull();
  });

  test("rejects values above host core count", () => {
    if (hostCores > 0) {
      const err = validateCpus(hostCores + 1);
      expect(err).toContain("exceeds host core count");
    }
  });
});
