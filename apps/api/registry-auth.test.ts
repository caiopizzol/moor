import { describe, expect, test } from "bun:test";
import { buildPullAuthHeaders, buildXRegistryAuth, deriveSecretKind } from "./registry-auth";

function decodeHeader(header: string): {
  username: string;
  password: string;
  serveraddress: string;
} {
  // Decode via Node's base64url mode so the test is explicit about
  // the wire format the encoder is supposed to produce.
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}

describe("buildXRegistryAuth", () => {
  test("encodes username, password, serveraddress as base64url JSON", () => {
    const header = buildXRegistryAuth("alice", "s3cret", "ghcr.io");
    expect(decodeHeader(header)).toEqual({
      username: "alice",
      password: "s3cret",
      serveraddress: "ghcr.io",
    });
  });

  test("uses Docker Hub special serveraddress when provided", () => {
    const header = buildXRegistryAuth("alice", "s3cret", "https://index.docker.io/v1/");
    expect(decodeHeader(header).serveraddress).toBe("https://index.docker.io/v1/");
  });

  test("output is URL-safe: no + or / characters even for payloads that produce them in standard base64", () => {
    // Password chosen so the JSON's base64 contains both + and /
    // characters under StdEncoding; URL-safe encoding must replace
    // them with - and _ respectively.
    const header = buildXRegistryAuth("alice", "~+/=secret?", "ghcr.io");
    expect(header.includes("+")).toBe(false);
    expect(header.includes("/")).toBe(false);
    // Round-trip the payload to be sure.
    expect(decodeHeader(header)).toEqual({
      username: "alice",
      password: "~+/=secret?",
      serveraddress: "ghcr.io",
    });
  });

  test("preserves = padding (matches Go's base64.URLEncoding, not RawURLEncoding)", () => {
    // Inputs whose JSON byte length is 52 (mod 3 = 1), so the base64
    // form requires two = padding chars. Regression guard against
    // accidentally switching to RawURLEncoding which would strip them.
    const header = buildXRegistryAuth("u", "p", "ho");
    expect(header.endsWith("==")).toBe(true);
  });
});

describe("buildPullAuthHeaders", () => {
  test("no credential → empty headers (anonymous pull preserved)", () => {
    expect(buildPullAuthHeaders({ serverAddress: "ghcr.io" }, null)).toEqual({});
  });

  test("credential + non-Docker-Hub registry → header uses bare host as serveraddress", () => {
    const headers = buildPullAuthHeaders(
      { serverAddress: "ghcr.io" },
      { username: "alice", secret: "ghp_abc" },
    );
    expect(Object.keys(headers)).toEqual(["X-Registry-Auth"]);
    const decoded = JSON.parse(
      Buffer.from(headers["X-Registry-Auth"], "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      username: "alice",
      password: "ghp_abc",
      serveraddress: "ghcr.io",
    });
  });

  test("credential + Docker Hub → header uses the special Docker Hub serveraddress", () => {
    const headers = buildPullAuthHeaders(
      { serverAddress: "https://index.docker.io/v1/" },
      { username: "alice", secret: "hunter2" },
    );
    const decoded = JSON.parse(
      Buffer.from(headers["X-Registry-Auth"], "base64url").toString("utf8"),
    );
    expect(decoded.serveraddress).toBe("https://index.docker.io/v1/");
  });

  test("credential + port-bearing registry → header serveraddress includes port", () => {
    const headers = buildPullAuthHeaders(
      { serverAddress: "localhost:5050" },
      { username: "alice", secret: "ghp_x" },
    );
    const decoded = JSON.parse(
      Buffer.from(headers["X-Registry-Auth"], "base64url").toString("utf8"),
    );
    expect(decoded.serveraddress).toBe("localhost:5050");
  });
});

describe("deriveSecretKind", () => {
  test("ghp_ prefix yields github_classic_pat", () => {
    expect(deriveSecretKind("ghp_abc123def456")).toBe("github_classic_pat");
  });

  test("github_pat_ prefix yields github_fine_grained_pat", () => {
    expect(deriveSecretKind("github_pat_11ABCDEFG_xyz")).toBe("github_fine_grained_pat");
  });

  test("unknown prefix yields unknown (no guessing for arbitrary passwords)", () => {
    expect(deriveSecretKind("hunter2")).toBe("unknown");
    expect(deriveSecretKind("dckr_pat_ABCDEFG")).toBe("unknown");
    expect(deriveSecretKind("")).toBe("unknown");
  });
});
