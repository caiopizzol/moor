import { describe, expect, test } from "bun:test";
import { validateCronSchedule, validateGithubRepoUrl, validateGithubUrl } from "./validators";

describe("GitHub URL validators", () => {
  test("validateGithubUrl accepts github.com and github.com subdomains", () => {
    expect(() => validateGithubUrl("https://github.com/moor-sh/moor")).not.toThrow();
    expect(() => validateGithubUrl("https://gist.github.com/user/id")).not.toThrow();
  });

  test("validateGithubUrl rejects invalid and lookalike hosts", () => {
    expect(() => validateGithubUrl("not a url")).toThrow("not a valid URL");
    expect(() => validateGithubUrl("https://evilgithub.com/owner/repo")).toThrow(
      'got hostname "evilgithub.com"',
    );
  });

  test("validateGithubRepoUrl accepts canonical owner/repo URLs", () => {
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo")).not.toThrow();
    expect(() => validateGithubRepoUrl("http://www.github.com/owner/repo.git/")).not.toThrow();
  });

  test("validateGithubRepoUrl rejects non-repo GitHub URLs and URL modifiers", () => {
    expect(() => validateGithubRepoUrl("https://gist.github.com/owner/repo")).toThrow(
      "github.com or www.github.com",
    );
    expect(() => validateGithubRepoUrl("https://github.com/owner/repo/tree/main")).toThrow(
      "/owner/repo",
    );
    expect(() => validateGithubRepoUrl("ssh://github.com/owner/repo")).toThrow("http or https");
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
