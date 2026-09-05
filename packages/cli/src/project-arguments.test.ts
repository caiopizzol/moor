import { expect, test } from "bun:test";
import { rebuildCommand } from "./commands/rebuild";
import { restartCommand } from "./commands/restart";
import { parseProjectArguments } from "./project-arguments";

for (const [name, command] of [
  ["restart", restartCommand],
  ["rebuild", rebuildCommand],
] as const) {
  for (const [args, error] of [
    [[], "Project is required"],
    [["api", "extra"], "Unexpected argument: extra"],
    [["api", "--unknown"], "Unknown option: --unknown"],
  ] as const) {
    for (const json of [false, true]) {
      test(`${name} rejects ${error} in ${json ? "JSON" : "human"} mode without requests`, async () => {
        const originalFetch = globalThis.fetch;
        let requests = 0;
        globalThis.fetch = Object.assign(
          async () => {
            requests++;
            throw new Error("Unexpected request");
          },
          { preconnect: originalFetch.preconnect },
        );
        const stdout: string[] = [];
        const stderr: string[] = [];
        try {
          expect(
            await command([...args, ...(json ? ["--json"] : [])], {
              stdout: (text) => stdout.push(text),
              stderr: (text) => stderr.push(text),
            }),
          ).toBe(1);
          expect(requests).toBe(0);
          expect(stdout).toEqual([]);
          expect(stderr[0]).toBe(json ? `${JSON.stringify({ error })}\n` : `Error: ${error}\n`);
          expect(stderr.length).toBe(json ? 1 : 2);
          if (!json) expect(stderr[1]).toStartWith(`Usage: moor ${name}`);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
}

test("project arguments accept boolean flags in any position and preserve the selector", () => {
  const output = {
    stdout: () => {
      throw new Error("Unexpected output");
    },
    stderr: () => {
      throw new Error("Unexpected error");
    },
  };
  for (const args of [
    ["--json", "7", "--no-cache"],
    ["--no-cache", "--json", "7"],
  ]) {
    expect(parseProjectArguments(args, "usage", output, ["--no-cache"])).toEqual({
      selector: "7",
      json: true,
      flags: new Set(["--no-cache"]),
    });
  }
});

test("help takes precedence over invalid arguments", () => {
  const stdout: string[] = [];
  for (const help of ["--help", "-h"]) {
    expect(
      parseProjectArguments(["--unknown", help], "usage", {
        stdout: (text) => stdout.push(text),
        stderr: () => {
          throw new Error("Unexpected error");
        },
      }),
    ).toBe(0);
  }
  expect(stdout).toEqual(["usage\n", "usage\n"]);
});
