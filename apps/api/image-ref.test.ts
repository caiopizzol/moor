import { describe, expect, test } from "bun:test";
import { parseImageRef } from "./image-ref";

const HUB_HOST = "docker.io";
const HUB_SERVER = "https://index.docker.io/v1/";

describe("parseImageRef - Docker Hub", () => {
  test("bare name defaults to latest tag and Docker Hub host", () => {
    expect(parseImageRef("nginx")).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: "nginx",
      tag: "latest",
    });
  });

  test("tagged bare name", () => {
    expect(parseImageRef("nginx:1.25")).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: "nginx",
      tag: "1.25",
    });
  });

  test("library/nginx is Docker Hub", () => {
    expect(parseImageRef("library/nginx")).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: "library/nginx",
      tag: "latest",
    });
  });

  test("user/image is Docker Hub (no dot, no port, not localhost)", () => {
    expect(parseImageRef("bitnami/postgresql:15")).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: "bitnami/postgresql",
      tag: "15",
    });
  });
});

describe("parseImageRef - other registries", () => {
  test("ghcr.io untagged", () => {
    expect(parseImageRef("ghcr.io/owner/img")).toEqual({
      registryHost: "ghcr.io",
      serverAddress: "ghcr.io",
      fromImage: "ghcr.io/owner/img",
      tag: "latest",
    });
  });

  test("ghcr.io tagged", () => {
    expect(parseImageRef("ghcr.io/owner/img:v1.2.3")).toEqual({
      registryHost: "ghcr.io",
      serverAddress: "ghcr.io",
      fromImage: "ghcr.io/owner/img",
      tag: "v1.2.3",
    });
  });

  test("multi-level path under gcr.io", () => {
    expect(parseImageRef("gcr.io/project/team/img:v1")).toEqual({
      registryHost: "gcr.io",
      serverAddress: "gcr.io",
      fromImage: "gcr.io/project/team/img",
      tag: "v1",
    });
  });

  test("registry hostname with port (non-localhost)", () => {
    expect(parseImageRef("registry.example.com:5000/img:tag")).toEqual({
      registryHost: "registry.example.com:5000",
      serverAddress: "registry.example.com:5000",
      fromImage: "registry.example.com:5000/img",
      tag: "tag",
    });
  });
});

describe("parseImageRef - localhost with port (the bug fix)", () => {
  test("localhost:5000/img with no tag returns latest", () => {
    // The naive lastIndexOf(":") split parsed this as
    // image=localhost, tag=5000/img. Confirms the dormant bug is gone.
    expect(parseImageRef("localhost:5000/img")).toEqual({
      registryHost: "localhost:5000",
      serverAddress: "localhost:5000",
      fromImage: "localhost:5000/img",
      tag: "latest",
    });
  });

  test("localhost:5000/img:v1", () => {
    expect(parseImageRef("localhost:5000/img:v1")).toEqual({
      registryHost: "localhost:5000",
      serverAddress: "localhost:5000",
      fromImage: "localhost:5000/img",
      tag: "v1",
    });
  });
});

describe("parseImageRef - digest refs", () => {
  const DIGEST = "@sha256:1111111111111111111111111111111111111111111111111111111111111111";

  test("Docker Hub digest ref omits tag", () => {
    expect(parseImageRef(`nginx${DIGEST}`)).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: `nginx${DIGEST}`,
      tag: null,
    });
  });

  test("ghcr.io digest ref omits tag", () => {
    expect(parseImageRef(`ghcr.io/owner/img${DIGEST}`)).toEqual({
      registryHost: "ghcr.io",
      serverAddress: "ghcr.io",
      fromImage: `ghcr.io/owner/img${DIGEST}`,
      tag: null,
    });
  });

  test("tag+digest: digest wins, tag is dropped", () => {
    // Daemon ignores tag when fromImage carries a digest; the parser
    // strips the tag rather than passing two competing identifiers.
    expect(parseImageRef(`nginx:1.25${DIGEST}`)).toEqual({
      registryHost: HUB_HOST,
      serverAddress: HUB_SERVER,
      fromImage: `nginx${DIGEST}`,
      tag: null,
    });
  });
});

describe("parseImageRef - malformed input", () => {
  test("empty string throws", () => {
    expect(() => parseImageRef("")).toThrow(/empty/);
  });

  test("trailing colon with no tag throws", () => {
    expect(() => parseImageRef("nginx:")).toThrow(/empty tag/);
  });

  test("trailing @ with no digest throws", () => {
    expect(() => parseImageRef("nginx@")).toThrow(/empty digest/);
  });

  test("digest with no image name throws", () => {
    expect(() =>
      parseImageRef("@sha256:1111111111111111111111111111111111111111111111111111111111111111"),
    ).toThrow(/missing image name/);
  });
});
