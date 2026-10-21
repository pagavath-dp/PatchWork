import { describe, expect, it, vi } from "vitest";
import { appendUniqueTasks, loadWorkspaceSections } from "./workspace-data";
import type { Task, Workspace } from "./api";

describe("workspace data loads", () => {
  it("appends each task only once when a later page overlaps existing data", () => {
    const task = { id: "task-1", revision: "a".repeat(64), title: "First", description: null,
      status: "TODO", priority: "MEDIUM", dueDate: null, assigneeId: null } as Task;
    const next = { ...task, id: "task-2", title: "Second" };
    expect(appendUniqueTasks([task], [task, next, next])).toEqual([task, next]);
  });

  it("keeps tasks available when GitHub links and repository requests fail", async () => {
    const workspace: Workspace = { id: "workspace-1", name: "PatchWork", slug: "patchwork", timeZone: "UTC", role: "OWNER" };
    const task: Task = { id: "task-1", revision: "a".repeat(64), title: "Keep the board available", description: null, status: "TODO", priority: "MEDIUM", dueDate: null, assigneeId: null };
    const request = vi.fn(async (path: string) => {
      if (path === "/api/v1/workspaces") return [workspace];
      if (path.endsWith("/tasks")) return { items: [task], nextCursor: null };
      if (path.endsWith("/members")) return [];
      throw new Error("GitHub unavailable");
    });
    const sections = loadWorkspaceSections(workspace.id, request as never);
    const [core, members, links, repository] = await Promise.allSettled([
      sections.core, sections.members, sections.links, sections.repository,
    ]);

    expect(core).toMatchObject({ status: "fulfilled", value: [[workspace], { items: [task], nextCursor: null }] });
    expect(members).toMatchObject({ status: "fulfilled", value: [] });
    expect(links).toMatchObject({ status: "rejected" });
    expect(repository).toMatchObject({ status: "rejected" });
  });
});
