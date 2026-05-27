// Pure unit tests for the build-error classifier. No DB, no network.

import { describe, expect, test } from "bun:test";

import { classifyBuildError } from "./build-error-classifier";

describe("classifyBuildError", () => {
  describe("source_credential_required", () => {
    test("github HTTPS auth failure (no credential)", () => {
      // What the Docker daemon's clone surfaces when github.com refuses
      // anonymous access to a private repo. The URL is already redacted
      // by the time it reaches the classifier.
      const msg = "ERROR: fatal: Authentication failed for 'https://github.com/owner/repo.git/'";
      expect(classifyBuildError(msg)).toBe("source_credential_required");
    });

    test("github HTTPS auth failure (invalid PAT)", () => {
      const msg =
        "Docker build failed: 500 ERROR: fatal: Authentication failed for 'https://github.com/owner/repo'";
      expect(classifyBuildError(msg)).toBe("source_credential_required");
    });

    test("git asking for credentials interactively (terminal prompts disabled)", () => {
      const msg =
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
      expect(classifyBuildError(msg)).toBe("source_credential_required");
    });

    test("invalid username or password phrasing", () => {
      const msg = "remote: Invalid username or password.";
      expect(classifyBuildError(msg)).toBe("source_credential_required");
    });

    test("case-insensitive (uppercase variant)", () => {
      const msg = "FATAL: AUTHENTICATION FAILED";
      expect(classifyBuildError(msg)).toBe("source_credential_required");
    });

    test("classifies the same message even after redaction", () => {
      // Redaction strips the user:pass@ prefix; the auth-failure phrase
      // is downstream of the URL so it survives.
      const redacted =
        "Docker build failed: 500 ERROR: fatal: Authentication failed for 'https://github.com/owner/repo/'";
      expect(classifyBuildError(redacted)).toBe("source_credential_required");
    });
  });

  describe("unknown", () => {
    test("network unreachable", () => {
      expect(
        classifyBuildError("fatal: unable to access: Could not resolve host: github.com"),
      ).toBe("unknown");
    });

    test("repository not found (kept unknown — different remediation)", () => {
      // Public repo that just doesn't exist, or private one where the user
      // mistyped. v1 keeps this as unknown because the fix is checking the
      // URL, not adding a PAT. parseLsRemoteOutput similarly disambiguates
      // via hasCredential context that isn't available at the build boundary.
      expect(classifyBuildError("remote: Repository not found")).toBe("unknown");
    });

    test("dockerfile syntax error", () => {
      expect(classifyBuildError("Dockerfile parse error line 3: unknown instruction: FOOO")).toBe(
        "unknown",
      );
    });

    test("npm install failure inside RUN", () => {
      expect(classifyBuildError("npm ERR! code E404\nnpm ERR! 404 Not Found")).toBe("unknown");
    });

    test("generic 500 with no recognizable cause", () => {
      expect(classifyBuildError("Docker build failed: 500 something went wrong")).toBe("unknown");
    });

    test("empty string", () => {
      expect(classifyBuildError("")).toBe("unknown");
    });
  });
});
