// #133: regression test for the history arg parser. The original took the
// first non-flag token as the project, so `--hours 1 fipe-pg` silently used
// the hours value ("1") as the project. Parsing must be order-independent.

import { describe, expect, test } from "bun:test";
import { parseHistoryArgs } from "./history";

describe("parseHistoryArgs", () => {
  test("project then flag", () => {
    expect(parseHistoryArgs(["fipe-pg", "--hours", "1"])).toEqual({ project: "fipe-pg", hours: 1 });
  });

  test("flag then project (regression: was mis-parsed as project '1')", () => {
    expect(parseHistoryArgs(["--hours", "1", "fipe-pg"])).toEqual({ project: "fipe-pg", hours: 1 });
  });

  test("--hours=N form", () => {
    expect(parseHistoryArgs(["--hours=6", "fipe-pg"])).toEqual({ project: "fipe-pg", hours: 6 });
  });

  test("default hours is 24 when omitted", () => {
    expect(parseHistoryArgs(["fipe-pg"])).toEqual({ project: "fipe-pg", hours: 24 });
  });

  test("missing project → error, no project", () => {
    const r = parseHistoryArgs(["--hours", "1"]);
    expect(r.project).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  test("invalid hours → error", () => {
    expect(parseHistoryArgs(["fipe-pg", "--hours", "0"]).error).toBeTruthy();
    expect(parseHistoryArgs(["fipe-pg", "--hours", "-3"]).error).toBeTruthy();
    expect(parseHistoryArgs(["fipe-pg", "--hours", "abc"]).error).toBeTruthy();
    expect(parseHistoryArgs(["fipe-pg", "--hours"]).error).toBeTruthy(); // no value
  });
});
