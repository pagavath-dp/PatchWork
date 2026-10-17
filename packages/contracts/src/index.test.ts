import { describe, expect, it } from "vitest";
import { createTaskGitHubLinkSchema, createTaskSchema, createWorkspaceSchema, startRepositoryConnectionSchema, updateTaskSchema } from "./index.js";

describe("request contracts", () => {
  it("rejects extra workspace fields", () => {
    expect(createWorkspaceSchema.safeParse({ name: "Team", slug: "team", ownerId: "spoofed" }).success).toBe(false);
  });

  it("rejects malformed dates and empty task titles", () => {
    expect(createTaskSchema.safeParse({ title: "", dueDate: "2026-02-30" }).success).toBe(false);
  });

  it("requires a supported task change and validates status", () => {
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(updateTaskSchema.safeParse({ status: "BLOCKED" }).success).toBe(false);
    expect(updateTaskSchema.parse({ title: "  Ready  ", status: "DONE" })).toEqual({ title: "Ready", status: "DONE" });
  });
  it("validates due date, assignee changes, and GitHub item identifiers", () => {
    const id = "77c92020-3ec1-49aa-b2ff-31d81ae00a12";
    expect(updateTaskSchema.safeParse({ dueDate: "2026-02-30" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ dueDate: null, assigneeId: null }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ assigneeId: id }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ assigneeId: "wrong" }).success).toBe(false);
    expect(createTaskGitHubLinkSchema.safeParse({ itemId: id }).success).toBe(true);
    expect(createTaskGitHubLinkSchema.safeParse({ itemId: id, htmlUrl: "https://github.com/other/repo/issues/1" }).success).toBe(false);
  });
  it("accepts only a workspace UUID and owner/repository for GitHub connection", () => {
    const input = { workspaceId: "77c92020-3ec1-49aa-b2ff-31d81ae00a12", repository: "team/project" };
    expect(startRepositoryConnectionSchema.safeParse(input).success).toBe(true);
    expect(startRepositoryConnectionSchema.safeParse({ ...input, repository: "https://github.com/team/project" }).success).toBe(false);
    expect(startRepositoryConnectionSchema.safeParse({ ...input, installationId: "123" }).success).toBe(false);
  });
});
