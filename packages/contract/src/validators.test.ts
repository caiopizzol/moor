import { describe, expect, test } from "bun:test";
import {
  CRON_TIMEOUT_DEFAULT_MS,
  CRON_TIMEOUT_MAX_MS,
  validateCronSchedule,
  validateCronTimeoutMs,
  validateGithubRepoUrl,
  validateGithubUrl,
} from "./validators";

describe("GitHub URL validators", () => {
  test("validateGithubUrl accepts exactly github.com and www.github.com over https", () => {
    expect(() => validateGithubUrl("https://github.com/moor-sh/moor")).not.toThrow();
    expect(() => validateGithubUrl("https://www.github.com/moor-sh/moor")).not.toThrow();
  });

  test("validateGithubUrl rejects invalid, lookalike, subdomain, and non-https URLs", () => {
    expect(() => validateGithubUrl("not a url")).toThrow("not a valid URL");
    expect(() => validateGithubUrl("https://evilgithub.com/owner/repo")).toThrow(
      'got "evilgithub.com"',
    );
    expect(() => validateGithubUrl("https://gist.github.com/user/id")).toThrow(
      "github.com or www.github.com",
    );
    expect(() => validateGithubUrl("http://github.com/owner/repo")).toThrow("must use https");
  });

  test("validateGithubRepoUrl accepts canonical owner/repo URLs", () => {
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo")).not.toThrow();
    expect(() => validateGithubRepoUrl("https://www.github.com/owner/repo.git/")).not.toThrow();
  });

  test("validateGithubRepoUrl rejects non-repo GitHub URLs and URL modifiers", () => {
    expect(() => validateGithubRepoUrl("https://gist.github.com/owner/repo")).toThrow(
      "github.com or www.github.com",
    );
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo/tree/main")).toThrow(
      "/owner/repo",
    );
    expect(() => validateGithubRepoUrl("http://github.com/owner/repo")).toThrow("must use https");
    expect(() => validateGithubRepoUrl("ssh://github.com/owner/repo")).toThrow("must use https");
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo?tab=readme")).toThrow(
      "query parameters",
    );
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo#readme")).toThrow(
      "URL fragment",
    );
  });
});

describe("validateCronSchedule", () => {
  test("accepts numeric 5-field schedules supported by the scheduler", () => {
    expect(validateCronSchedule("*/5 0-23/2 * 1,12 0")).toBeNull();
    expect(validateCronSchedule("0 3 * * *")).toBeNull();
  });

  test("rejects unsupported field counts and crontab syntax", () => {
    expect(validateCronSchedule("* * *")).toBe(
      "schedule must have exactly 5 space-separated fields (got 3)",
    );
    expect(validateCronSchedule("0 0 * jan *")).toBe(
      "month: month/day names are not supported, use numeric values",
    );
    expect(validateCronSchedule("0 0 L * *")).toBe("day-of-month: ?, L, W, # are not supported");
  });

  test("rejects values and ranges the scheduler cannot match correctly", () => {
    expect(validateCronSchedule("0 0 * * 7")).toBe("day-of-week: 7 out of bounds [0-6]");
    expect(validateCronSchedule("1,,2 * * * *")).toBe("minute: empty list element");
    expect(validateCronSchedule("10-1 * * * *")).toBe("minute: range 10-1 is descending");
    expect(validateCronSchedule("*/0 * * * *")).toBe(
      'minute: step must be a positive integer (got "0")',
    );
  });
});

describe("validateCronTimeoutMs", () => {
  test("accepts the default and multi-day cron timeouts", () => {
    expect(validateCronTimeoutMs(CRON_TIMEOUT_DEFAULT_MS)).toBeNull();
    expect(validateCronTimeoutMs(3 * 60 * 60 * 1000)).toBeNull();
    expect(validateCronTimeoutMs(CRON_TIMEOUT_MAX_MS)).toBeNull();
  });

  test("rejects non-integers and values outside the supported range", () => {
    expect(validateCronTimeoutMs(999)).toContain("timeout_ms must be an integer between");
    expect(validateCronTimeoutMs(CRON_TIMEOUT_MAX_MS + 1)).toContain(
      "timeout_ms must be an integer between",
    );
    expect(validateCronTimeoutMs(60_000.5)).toContain("timeout_ms must be an integer between");
    expect(validateCronTimeoutMs("60000")).toContain("timeout_ms must be an integer between");
  });
});
