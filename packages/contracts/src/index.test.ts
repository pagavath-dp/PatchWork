import { describe, expect, it } from "vitest";
import { activityCursorSchema, createInvitationSchema, createTaskGitHubLinkSchema, createTaskSchema, createWorkspaceSchema, invitationTokenSchema, startRepositoryConnectionSchema, updateMemberRoleSchema, updateTaskSchema } from "./index.js";

describe("request contracts", () => {
  it("rejects extra workspace fields", () => {
    expect(createWorkspaceSchema.safeParse({ name: "Team", slug: "team", ownerId: "spoofed" }).success).toBe(false);
  });

  it("rejects malformed dates and empty task titles", () => {
    expect(createTaskSchema.safeParse({ title: "", dueDate: "2026-02-30" }).success).toBe(false);
  });

  it("requires a supported task change and validates status", () => {
    const expectedRevision = "a".repeat(64);
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(updateTaskSchema.safeParse({ expectedRevision }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ status: "DONE" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ status: "BLOCKED" }).success).toBe(false);
    expect(updateTaskSchema.parse({ expectedRevision, title: "  Ready  ", status: "DONE" })).toEqual({ expectedRevision, title: "Ready", status: "DONE" });
  });
  it("validates due date, assignee changes, and GitHub item identifiers", () => {
    const id = "77c92020-3ec1-49aa-b2ff-31d81ae00a12";
    const expectedRevision = "a".repeat(64);
    expect(updateTaskSchema.safeParse({ expectedRevision, dueDate: "2026-02-30" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ expectedRevision, dueDate: null, assigneeId: null }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ expectedRevision, assigneeId: id }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ expectedRevision, assigneeId: "wrong" }).success).toBe(false);
    expect(createTaskGitHubLinkSchema.safeParse({ itemId: id }).success).toBe(true);
    expect(createTaskGitHubLinkSchema.safeParse({ itemId: id, htmlUrl: "https://github.com/other/repo/issues/1" }).success).toBe(false);
  });
  it("accepts only a workspace UUID and owner/repository for GitHub connection", () => {
    const input = { workspaceId: "77c92020-3ec1-49aa-b2ff-31d81ae00a12", repository: "team/project" };
    expect(startRepositoryConnectionSchema.safeParse(input).success).toBe(true);
    expect(startRepositoryConnectionSchema.safeParse({ ...input, repository: "https://github.com/team/project" }).success).toBe(false);
    expect(startRepositoryConnectionSchema.safeParse({ ...input, installationId: "123" }).success).toBe(false);
  });
  it("validates invitation recipients, roles, tokens, and role updates", () => {
    expect(createInvitationSchema.safeParse({ githubLogin: "teammate", role: "MEMBER" }).success).toBe(true);
    expect(createInvitationSchema.safeParse({ githubLogin: "bad user", role: "MEMBER" }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ githubLogin: "teammate", role: "OWNER" }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ githubLogin: "teammate", role: "MEMBER", inviterId: "spoofed" }).success).toBe(false);
    expect(updateMemberRoleSchema.safeParse({ role: "OWNER" }).success).toBe(true);
    expect(updateMemberRoleSchema.safeParse({ role: "SUPERUSER" }).success).toBe(false);
    expect(invitationTokenSchema.safeParse("x".repeat(43)).success).toBe(true);
    expect(invitationTokenSchema.safeParse("short").success).toBe(false);
  });
  it("accepts only bounded opaque activity cursors", () => {
    expect(activityCursorSchema.safeParse("eyJ2IjoxfQ.c2lnbmF0dXJl").success).toBe(true);
    expect(activityCursorSchema.safeParse("not a cursor").success).toBe(false);
    expect(activityCursorSchema.safeParse("x".repeat(1025)).success).toBe(false);
  });
});
