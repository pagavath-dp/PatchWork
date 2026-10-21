import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@patchwork/db";
import { HttpError } from "../src/http.js";
import { createInvitation, listInvitations, resolveGitHubIdentity, respondToInvitation, updateMemberRole } from "../src/workspace-membership.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub invitation recipient lookup", () => {
  it("binds a username to an immutable GitHub account ID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 12345, login: "Teammate" }), { status: 200 })));
    expect(await resolveGitHubIdentity("teammate")).toEqual({ githubId: "12345", login: "Teammate" });
  });

  it("rejects missing, malformed, or unavailable GitHub accounts", async () => {
    for (const [response, code] of [
      [new Response(null, { status: 404 }), "RECIPIENT_NOT_FOUND"],
      [new Response(null, { status: 403 }), "GITHUB_LOOKUP_UNAVAILABLE"],
      [new Response(JSON.stringify({ id: "123", login: "teammate" }), { status: 200 }), "GITHUB_LOOKUP_UNAVAILABLE"],
      [new Response(JSON.stringify({ id: 123, login: "different" }), { status: 200 }), "GITHUB_LOOKUP_UNAVAILABLE"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(resolveGitHubIdentity("teammate")).rejects.toMatchObject({ code });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network details")));
    await expect(resolveGitHubIdentity("teammate")).rejects.toMatchObject({ code: "GITHUB_LOOKUP_UNAVAILABLE" });
  });
});

describe("invitation authorization before external lookup", () => {
  const workspaceId = "77c92020-3ec1-49aa-b2ff-31d81ae00a12";
  const actorId = "88c92020-3ec1-49aa-b2ff-31d81ae00a12";
  function client(role: string | null): PrismaClient {
    return { workspaceMember: { findUnique: vi.fn().mockResolvedValue(role ? { role } : null) } } as unknown as PrismaClient;
  }

  it("hides workspaces from nonmembers and denies viewer/member invitation writes", async () => {
    const resolver = vi.fn();
    for (const [role, status] of [[null, 404], ["VIEWER", 403], ["MEMBER", 403]] as const) {
      await expect(createInvitation(client(role), workspaceId, actorId, { githubLogin: "teammate", role: "MEMBER" }, resolver))
        .rejects.toMatchObject({ status });
    }
    expect(resolver).not.toHaveBeenCalled();
    await expect(listInvitations(client("VIEWER"), workspaceId, actorId)).rejects.toBeInstanceOf(HttpError);
  });

  it("prevents admins from inviting another admin", async () => {
    const resolver = vi.fn();
    await expect(createInvitation(client("ADMIN"), workspaceId, actorId, { githubLogin: "teammate", role: "ADMIN" }, resolver))
      .rejects.toMatchObject({ status: 403 });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("membership safeguards", () => {
  const workspaceId = "77c92020-3ec1-49aa-b2ff-31d81ae00a12";
  const actorId = "88c92020-3ec1-49aa-b2ff-31d81ae00a12";
  const token = "x".repeat(43);
  function transactional(tx: object): PrismaClient {
    return { $transaction: (callback: (client: object) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  }

  it("rejects a different recipient and expired or used invitations without creating membership", async () => {
    for (const [status, expiresAt, githubId, expected] of [
      ["PENDING", new Date(Date.now() + 60_000), "different", 404],
      ["PENDING", new Date(Date.now() - 1000), "account", 410],
      ["REVOKED", new Date(Date.now() + 60_000), "account", 409],
      ["ACCEPTED", new Date(Date.now() + 60_000), "account", 409],
    ] as const) {
      const create = vi.fn();
      const invitation = { id: "invitation", workspaceId, recipientGithubId: "account", status, expiresAt };
      const tx = { $queryRaw: vi.fn().mockResolvedValue([]), workspaceInvitation: {
        findUnique: vi.fn().mockResolvedValue({ workspaceId }), findUniqueOrThrow: vi.fn().mockResolvedValue(invitation),
      }, workspaceMember: { create } };
      await expect(respondToInvitation(transactional(tx), token, { id: actorId, githubId }, "ACCEPTED"))
        .rejects.toMatchObject({ status: expected });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("does not demote the last owner or let an admin modify another admin", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), workspaceMember: {
      findUnique: vi.fn().mockResolvedValueOnce({ role: "OWNER" }).mockResolvedValueOnce({ role: "OWNER" }),
      findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(),
    } };
    await expect(updateMemberRole(transactional(tx), workspaceId, actorId, actorId, { role: "MEMBER" }))
      .rejects.toMatchObject({ code: "LAST_OWNER", status: 409 });
    expect(tx.workspaceMember.update).not.toHaveBeenCalled();

    const adminTx = { $queryRaw: vi.fn().mockResolvedValue([]), workspaceMember: {
      findUnique: vi.fn().mockResolvedValueOnce({ role: "ADMIN" }).mockResolvedValueOnce({ role: "ADMIN" }),
      update: vi.fn(),
    } };
    await expect(updateMemberRole(transactional(adminTx), workspaceId, "99c92020-3ec1-49aa-b2ff-31d81ae00a12", actorId,
      { role: "MEMBER" })).rejects.toMatchObject({ status: 403 });
    expect(adminTx.workspaceMember.update).not.toHaveBeenCalled();
  });
});
