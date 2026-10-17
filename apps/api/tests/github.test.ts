import { describe, expect, it, vi, afterEach } from "vitest";
import { createGitHubGateway, fetchGitHubPages } from "../src/github.js";
import { z } from "zod";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = { appOrigin: "http://localhost:3000", callbackUrl: "http://localhost:3000/auth/github/callback",
  githubClientId: "test", githubClientSecret: "test", secureCookies: false,
  githubApp: { appId: "1", clientId: "test", clientSecret: "test", privateKeyPath: "/nonexistent",
    slug: "test", callbackUrl: "http://localhost:3000/auth/github-app/callback" } };

afterEach(() => vi.unstubAllGlobals());
describe("GitHub API errors", () => {
  for (const [status, headers, code] of [
    [401, {}, "GITHUB_ACCESS_REVOKED"],
    [403, {}, "GITHUB_PERMISSION_DENIED"],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED"],
    [429, {}, "GITHUB_RATE_LIMITED"],
    [500, {}, "GITHUB_UNAVAILABLE"],
  ] as const) {
    it(`maps GitHub ${status} to ${code}`, async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status, headers })));
      await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
        .rejects.toMatchObject({ code });
    });
  }
  it("handles network failure without exposing token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network secret")));
    await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
      .rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE", message: "GitHub API is unavailable" });
  });
  it("recognizes a secondary limit even when the primary counter is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "You have exceeded a secondary rate limit. Please wait before you try again.",
    }), { status: 403, headers: { "x-ratelimit-remaining": "42", "retry-after": "90" } })));
    await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
      .rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", message: expect.stringContaining("90 seconds") });
  });

  it("recognizes a secondary limit from the response message without retry headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "You have exceeded a secondary rate limit.",
    }), { status: 403, headers: { "x-ratelimit-remaining": "42" } })));
    await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
      .rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED", message: expect.stringContaining("Wait a few minutes") });
  });

  it("uses the primary rate-limit reset when retry-after is absent", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    })));
    const failure = createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo");
    await expect(failure).rejects.toMatchObject({ code: "GITHUB_RATE_LIMITED",
      message: expect.stringMatching(/Wait at least 12[01] seconds/) });
  });

  it("keeps a genuine permission error distinct from a rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
      status: 403, headers: { "x-ratelimit-remaining": "42" },
    })));
    await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
      .rejects.toMatchObject({ code: "GITHUB_PERMISSION_DENIED" });
  });
  it("rejects malformed GitHub data with a sanitized error", async () => {
    for (const value of [null, { unexpected: true }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 })));
      await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
        .rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
    }
  });
  it("rejects an authorization from a different GitHub account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 2 }), { status: 200 })));
    await expect(createGitHubGateway(config).verifyUserRepository("token", "1", "owner/repo"))
      .rejects.toMatchObject({ code: "GITHUB_ACCOUNT_MISMATCH" });
  });
  it("rejects null, malformed arrays, and malformed entries", async () => {
    for (const value of [null, {}, [{ id: "bad" }]]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 })));
      await expect(fetchGitHubPages("https://api.github.com/repos/owner/repo/issues", "token", z.object({ id: z.number() })))
        .rejects.toMatchObject({ code: "GITHUB_INVALID_RESPONSE" });
    }
  });
  it("follows GitHub pagination and refuses to silently truncate", async () => {
    const next = '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { link: next } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const records = await fetchGitHubPages("https://api.github.com/repos/owner/repo/issues", "token", z.object({ id: z.number() }));
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { link: next } })));
    await expect(fetchGitHubPages("https://api.github.com/repos/owner/repo/issues", "token", z.object({ id: z.number() }), 2))
      .rejects.toMatchObject({ code: "GITHUB_RESULT_LIMIT" });
  });
});
