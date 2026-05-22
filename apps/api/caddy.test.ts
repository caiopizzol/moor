// Tests for #31: checkDns plumbing. The previous implementation shelled out to
// dig/curl; this verifies the runtime-API replacement handles the cases the
// shell version mishandled (missing binaries, NXDOMAIN, malformed responses).

// MOOR_DB_PATH must be set before ../db.ts evaluates (caddy.ts imports it).
process.env.MOOR_DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { lookupA, getServerIp } = await import("./caddy");

describe("lookupA", () => {
  test("returns the first IPv4 address when the resolver succeeds", async () => {
    const fake = async () => ["192.0.2.10", "192.0.2.11"];
    expect(await lookupA("example.com", fake)).toBe("192.0.2.10");
  });

  test("skips non-IPv4 entries and returns the first IPv4", async () => {
    const fake = async () => ["not-an-ip", "2001:db8::1", "203.0.113.5"];
    expect(await lookupA("example.com", fake)).toBe("203.0.113.5");
  });

  test("returns null on ENOTFOUND", async () => {
    const fake = async () => {
      const e = new Error("getaddrinfo ENOTFOUND") as NodeJS.ErrnoException;
      e.code = "ENOTFOUND";
      throw e;
    };
    expect(await lookupA("definitely-not-a-real-domain.invalid", fake)).toBeNull();
  });

  test("returns null on ENODATA", async () => {
    const fake = async () => {
      const e = new Error("queryA ENODATA") as NodeJS.ErrnoException;
      e.code = "ENODATA";
      throw e;
    };
    expect(await lookupA("no-a-record.example", fake)).toBeNull();
  });

  test("returns null when the resolver returns an empty array", async () => {
    const fake = async () => [];
    expect(await lookupA("example.com", fake)).toBeNull();
  });

  test("returns null when the resolver hangs longer than the timeout", async () => {
    const fake = () => new Promise<string[]>(() => {}); // never resolves
    expect(await lookupA("example.com", fake)).toBeNull();
  }, 5000);
});

describe("getServerIp", () => {
  test("returns the IP from a 200 response with a valid IPv4 body", async () => {
    const fake = (async () =>
      new Response("203.0.113.42\n", { status: 200 })) as unknown as typeof fetch;
    expect(await getServerIp(fake)).toBe("203.0.113.42");
  });

  test("returns null when the upstream returns a non-2xx status", async () => {
    const fake = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    expect(await getServerIp(fake)).toBeNull();
  });

  test("returns null when the body is not an IPv4 address", async () => {
    const fake = (async () =>
      new Response("not-an-ip", { status: 200 })) as unknown as typeof fetch;
    expect(await getServerIp(fake)).toBeNull();
  });

  test("returns null when the fetch rejects", async () => {
    const fake = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await getServerIp(fake)).toBeNull();
  });
});
