import { describe, expect, it } from "vitest";
import { connectionErrorMessage, repositoryAvailability } from "./repository-availability";

describe("repository availability", () => {
  it("keeps saved snapshots visible without GitHub App configuration", () => {
    expect(repositoryAvailability(false, true, false)).toBe("cached");
    expect(repositoryAvailability(false, true, true)).toBe("cached");
  });

  it("only permits live refresh for a configured, connected repository", () => {
    expect(repositoryAvailability(true, true, false)).toBe("live");
    expect(repositoryAvailability(true, true, true)).toBe("cached");
    expect(repositoryAvailability(false, false, false)).toBe("setup");
    expect(repositoryAvailability(true, false, false)).toBe("connect");
  });
});

describe("GitHub connection errors", () => {
  it("explains an unavailable private key without exposing its path", () => {
    const message = connectionErrorMessage("GITHUB_KEY_UNAVAILABLE");
    expect(message).toContain("private key");
    expect(message).toContain("project maintainer");
    expect(message).not.toContain("/");
  });

  it("explains the result limit and that the old snapshot remains", () => {
    const message = connectionErrorMessage("GITHUB_RESULT_LIMIT");
    expect(message).toContain("more records");
    expect(message).toContain("previous snapshot is unchanged");
  });

  it("uses a fixed safe message for unknown codes", () => {
    expect(connectionErrorMessage("private/path/token")).toBe("GitHub connection failed. Check the App installation and try again.");
    for (const code of ["constructor", "__proto__", "toString"]) {
      expect(connectionErrorMessage(code)).toBe("GitHub connection failed. Check the App installation and try again.");
    }
    expect(connectionErrorMessage("GITHUB_AUTH_FAILED")).toContain("not completed");
  });
});
