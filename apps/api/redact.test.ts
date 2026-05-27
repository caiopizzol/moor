import { describe, expect, test } from "bun:test";
import {
  reconcileGithubUrl,
  redactCredentials,
  redactCredentialsInText,
  redactDockerBuildPath,
  serializeProject,
} from "./redact";

describe("redactCredentials", () => {
  test("strips user:pass@host", () => {
    expect(redactCredentials("https://x-access-token:ghp_AAAA@github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("strips user@host with no password", () => {
    expect(redactCredentials("https://user@github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("preserves credential-free URL byte-for-byte", () => {
    const url = "https://github.com/owner/repo";
    expect(redactCredentials(url)).toBe(url);
  });

  test("preserves .git suffix", () => {
    expect(redactCredentials("https://x-access-token:T@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  test("returns null unchanged", () => {
    expect(redactCredentials(null)).toBeNull();
  });

  test("returns undefined unchanged", () => {
    expect(redactCredentials(undefined)).toBeUndefined();
  });

  test("returns empty string unchanged", () => {
    expect(redactCredentials("")).toBe("");
  });

  test("returns malformed input unchanged without throwing", () => {
    expect(redactCredentials("not a url")).toBe("not a url");
  });
});

describe("serializeProject", () => {
  test("redacts github_url and leaves other fields intact", () => {
    const row = {
      id: 1,
      name: "foo",
      github_url: "https://user:pass@github.com/o/r",
      docker_image: null,
      domain: "example.com",
    };
    const out = serializeProject(row);
    expect(out.github_url).toBe("https://github.com/o/r");
    expect(out.name).toBe("foo");
    expect(out.domain).toBe("example.com");
    expect(out.docker_image).toBeNull();
  });

  test("returns the same reference when there is nothing to redact", () => {
    const row = { id: 1, name: "foo", github_url: "https://github.com/o/r" };
    const out = serializeProject(row);
    expect(out).toBe(row); // identity: no allocation when no change
  });

  test("passes through null github_url", () => {
    const row = { id: 1, name: "foo", github_url: null };
    const out = serializeProject(row);
    expect(out.github_url).toBeNull();
  });
});

describe("redactDockerBuildPath", () => {
  test("redacts credentials inside the URL-encoded remote= param", () => {
    const params = new URLSearchParams({
      remote: "https://x-access-token:TOKEN_AAAA@github.com/o/r.git#main",
      t: "moor/o:latest",
      dockerfile: "Dockerfile",
    });
    const path = `/v1.44/build?${params}`;
    const redacted = redactDockerBuildPath(path);
    expect(redacted).not.toContain("TOKEN_AAAA");
    expect(redacted).not.toContain("x-access-token");
    // The branch fragment must survive.
    expect(decodeURIComponent(redacted)).toContain("#main");
    // Sibling query params must be preserved.
    const redactedParams = new URLSearchParams(redacted.split("?")[1]);
    expect(redactedParams.get("t")).toBe("moor/o:latest");
    expect(redactedParams.get("dockerfile")).toBe("Dockerfile");
  });

  test("returns path unchanged when remote has no credentials", () => {
    const path = "/v1.44/build?remote=https%3A%2F%2Fgithub.com%2Fo%2Fr.git%23main&t=tag";
    expect(redactDockerBuildPath(path)).toBe(path);
  });

  test("returns path unchanged when there is no query string", () => {
    expect(redactDockerBuildPath("/v1.44/containers/json")).toBe("/v1.44/containers/json");
  });

  test("returns path unchanged when remote= is absent", () => {
    const path = "/v1.44/containers/json?all=true";
    expect(redactDockerBuildPath(path)).toBe(path);
  });
});

describe("reconcileGithubUrl", () => {
  const stored = "https://x-access-token:TOKEN@github.com/owner/repo";

  test("incoming matches redacted stored => skip", () => {
    expect(reconcileGithubUrl("https://github.com/owner/repo", stored).skip).toBe(true);
  });

  test("incoming is a different repo => do not skip", () => {
    expect(reconcileGithubUrl("https://github.com/owner/different", stored).skip).toBe(false);
  });

  test("incoming carries new credentials => do not skip", () => {
    expect(
      reconcileGithubUrl("https://x-access-token:NEWTOKEN@github.com/owner/repo", stored).skip,
    ).toBe(false);
  });

  test("incoming is null (clearing) => do not skip", () => {
    expect(reconcileGithubUrl(null, stored).skip).toBe(false);
  });

  test("incoming is undefined (field not in body) => do not skip", () => {
    expect(reconcileGithubUrl(undefined, stored).skip).toBe(false);
  });

  test("stored is null => do not skip", () => {
    expect(reconcileGithubUrl("https://github.com/o/r", null).skip).toBe(false);
  });

  test("stored has no credentials and incoming matches => skip", () => {
    expect(reconcileGithubUrl("https://github.com/o/r", "https://github.com/o/r").skip).toBe(true);
  });
});

describe("redactCredentialsInText", () => {
  test("plain text without URLs is unchanged", () => {
    expect(redactCredentialsInText("nothing to redact here")).toBe("nothing to redact here");
  });

  test("credential-free URL is unchanged", () => {
    expect(redactCredentialsInText("clone https://github.com/owner/repo done")).toBe(
      "clone https://github.com/owner/repo done",
    );
  });

  test("credentialed URL embedded in message", () => {
    const before =
      "fatal: unable to access 'https://x-access-token:ghp_real@github.com/owner/repo.git/'";
    const after = redactCredentialsInText(before);
    expect(after).toBe("fatal: unable to access 'https://github.com/owner/repo.git/'");
    expect(after.includes("ghp_real")).toBe(false);
    expect(after.includes("x-access-token")).toBe(false);
  });

  test("multiple URLs in one message all redacted", () => {
    const before = "tried https://u1:p1@host1.com/a and https://u2:p2@host2.com/b; both failed";
    const after = redactCredentialsInText(before);
    expect(after).toBe("tried https://host1.com/a and https://host2.com/b; both failed");
    for (const leak of ["p1", "p2", "u1", "u2"]) {
      expect(after.includes(leak)).toBe(false);
    }
  });

  test("username-only URL is also redacted (bare usernames carry meaning)", () => {
    const before = "remote at https://operator@github.com/owner/repo";
    const after = redactCredentialsInText(before);
    expect(after).toBe("remote at https://github.com/owner/repo");
  });

  test("percent-encoded password (typical fine-grained PAT path)", () => {
    const before =
      'Authentication failed for "https://x-access-token:github_pat_11ABCDEFG%40@github.com/o/r"';
    const after = redactCredentialsInText(before);
    expect(after).toBe('Authentication failed for "https://github.com/o/r"');
  });

  test("URL inside JSON-escaped string", () => {
    const before =
      '{"errorDetail":{"message":"fatal: https://x:secret@github.com/o/r.git not reachable"}}';
    const after = redactCredentialsInText(before);
    expect(after).toBe(
      '{"errorDetail":{"message":"fatal: https://github.com/o/r.git not reachable"}}',
    );
    expect(after.includes("secret")).toBe(false);
  });

  test("http (not just https) is also redacted", () => {
    expect(redactCredentialsInText("plain http://u:p@host/path")).toBe("plain http://host/path");
  });

  test("URL at end of line with no trailing whitespace", () => {
    expect(redactCredentialsInText("Final: https://u:p@host/p")).toBe("Final: https://host/p");
  });

  test("URL immediately followed by colon (not part of credentials)", () => {
    // "https://host:port" without user/pass is a port; must not be touched.
    expect(redactCredentialsInText("connecting to https://github.com:443/owner")).toBe(
      "connecting to https://github.com:443/owner",
    );
  });

  test("URL with only colon (empty username) - empty userinfo, still redact", () => {
    // ":token@host" is rare but valid syntactically; redact to be safe.
    const after = redactCredentialsInText("see https://:token@host/path");
    expect(after.includes("token")).toBe(false);
  });

  test("URL with @ in the path (no userinfo) is left alone", () => {
    // "https://host/path@v1" has no userinfo - no @ before the first slash.
    expect(redactCredentialsInText("see https://github.com/owner/repo@v1")).toBe(
      "see https://github.com/owner/repo@v1",
    );
  });

  test("empty input", () => {
    expect(redactCredentialsInText("")).toBe("");
  });

  test("scheme alone is unchanged", () => {
    expect(redactCredentialsInText("see https://")).toBe("see https://");
  });
});
