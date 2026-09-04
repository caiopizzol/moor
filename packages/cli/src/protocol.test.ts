import { afterEach, describe, expect, test } from "bun:test";
import { formatResponseError, requestJson } from "./protocol";

const originalMoorUrl = process.env.MOOR_URL;
const originalMoorApiKey = process.env.MOOR_API_KEY;

afterEach(() => {
  restoreEnv("MOOR_URL", originalMoorUrl);
  restoreEnv("MOOR_API_KEY", originalMoorApiKey);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe("CLI protocol", () => {
  test("returns a contextual stderr error when a human response body is interrupted", async () => {
    process.env.MOOR_URL = "https://moor.test";
    process.env.MOOR_API_KEY = "test-key";
    const capture = captureOutput();
    const result = await requestJson(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("interrupted"));
            },
          }),
          { status: 500 },
        ),
      false,
      "Failed request",
      capture.output,
    );

    expect(result).toEqual({ ok: false });
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(["Error: Failed request: interrupted\n"]);
  });

  test("preserves structured response fields and normalizes an error message", async () => {
    expect(
      JSON.parse(
        await formatResponseError(
          Response.json({ code: "unavailable", detail: "docker" }, { status: 503 }),
          true,
        ),
      ),
    ).toEqual({ error: "HTTP 503", code: "unavailable", detail: "docker", status: 503 });
    expect(
      JSON.parse(
        await formatResponseError(Response.json({ error: "Unavailable" }, { status: 503 }), true),
      ),
    ).toEqual({ error: "Unavailable", status: 503 });
    expect(
      JSON.parse(
        await formatResponseError(
          Response.json({ error: { detail: "bad shape" } }, { status: 500 }),
          true,
        ),
      ),
    ).toEqual({ error: "HTTP 500", status: 500 });
  });

  test("keeps configuration failures machine-readable without making a request", async () => {
    delete process.env.MOOR_URL;
    process.env.MOOR_API_KEY = "test-key";
    let requested = false;
    const capture = captureOutput();

    const result = await requestJson(
      async () => {
        requested = true;
        return Response.json({});
      },
      true,
      "Failed request",
      capture.output,
    );

    expect(result.ok).toBe(false);
    expect(requested).toBe(false);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(['{"error":"MOOR_URL is not set"}\n']);
  });

  test("normalizes an interrupted error response body", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("response body interrupted"));
        },
      }),
      { status: 502 },
    );

    expect(JSON.parse(await formatResponseError(response, true))).toEqual({
      error: "response body interrupted",
      status: 502,
    });
  });
});
