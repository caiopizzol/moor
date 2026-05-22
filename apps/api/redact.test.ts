import { describe, expect, test } from "bun:test";
import {
  reconcileGithubUrl,
  redactCredentials,
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
