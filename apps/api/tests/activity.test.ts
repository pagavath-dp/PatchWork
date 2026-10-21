import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@patchwork/db";
import { changedFields, compareActivity, encodeActivityCursor, readWorkspaceActivity, writeTaskActivity } from "../src/activity-services.js";
import { createTask, taskRevision, updateTask } from "../src/services.js";
import { linkTaskGitHubItem, unlinkTaskGitHubItem } from "../src/github-services.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const signingKey = "unit-test-oauth-client-secret";

describe("task activity fields", () => {
  it("records only persisted changes, including cleared dates and assignees, without copying descriptions", () => {
    const before = { title: "First", description: "private detail", status: "TODO", priority: "LOW",
      dueDate: new Date("2026-10-20T00:00:00Z"), assigneeId: userId };
    expect(changedFields(before, { ...before })).toEqual([]);
    expect(changedFields(before, { ...before, description: null, status: "DONE", dueDate: null, assigneeId: null })).toEqual([
      { field: "description" }, { field: "status", before: "TODO", after: "DONE" },
      { field: "dueDate", before: "2026-10-20", after: null }, { field: "assigneeId", before: userId, after: null },
    ]);
  });

  it("keeps a deterministic order for equal timestamps", () => {
    const at = "2026-10-19T00:00:00.000Z";
    const items = [
      { id: eventId, source: "GITHUB" as const, occurredAt: at, actorLogin: null,
        event: "opened", itemNumber: 1, itemTitle: "Issue", itemUrl: "https://github.com/o/r/issues/1" },
      { id: taskId, source: "TASK" as const, occurredAt: at, actorLogin: "actor", actorId: userId,
        taskId, taskTitle: "Task", kind: "TASK_CREATED" as const, details: {} },
    ];
    expect(items.sort(compareActivity).map((item) => item.source)).toEqual(["TASK", "GITHUB"]);
  });

  it("creates an actor snapshot without taking actor data from the request", async () => {
    const create = vi.fn(async ({ data }) => data);
    const tx = { user: { findUniqueOrThrow: async () => ({ githubLogin: "historical-login" }) },
      taskActivity: { create } } as unknown as PrismaClient;
    await writeTaskActivity(tx, { workspaceId, taskId, actorId: userId, taskTitle: "Task", kind: "GITHUB_ITEM_LINKED",
      details: { item: { kind: "ISSUE", number: 3, title: "Issue", url: "https://github.com/o/r/issues/3", repository: "o/r" } } });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: userId,
      actorLogin: "historical-login", kind: "GITHUB_ITEM_LINKED" }) });
  });
});

describe("workspace activity authorization and pagination", () => {
  it("rejects nonmembers before reading activity", async () => {
    const events = vi.fn();
    const tx = { workspaceMember: { findUnique: async () => null }, gitHubConnection: { findUnique: vi.fn() },
      taskActivity: { findMany: events } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    await expect(readWorkspaceActivity(db, workspaceId, userId, false, signingKey, "invalid cursor")).rejects.toMatchObject({ status: 404 });
    expect(events).not.toHaveBeenCalled();
    expect(tx.gitHubConnection.findUnique).not.toHaveBeenCalled();
  });

  it("shows task activity without a GitHub connection and bounds the page", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      actorId: userId, actorLogin: "actor", taskId, taskTitle: "Task", kind: "TASK_UPDATED", details: {},
      occurredAt: new Date(Date.UTC(2026, 9, 18, 23, 59, 59 - index)) }));
    const tx = { workspaceMember: { findUnique: async () => ({ role: "VIEWER" }) },
      gitHubConnection: { findUnique: async () => null },
      taskActivity: { findMany: async () => rows }, gitHubActivity: { findMany: vi.fn() } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    const result = await readWorkspaceActivity(db, workspaceId, userId, false, signingKey);
    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).toBeTruthy();
    expect(result.github.snapshotStatus).toBe("unavailable");
    expect(tx.gitHubActivity.findMany).not.toHaveBeenCalled();
    await expect(readWorkspaceActivity(db, otherWorkspaceId, userId, false, signingKey, result.nextCursor!)).rejects.toMatchObject({ status: 400 });
    await expect(readWorkspaceActivity(db, workspaceId, userId, false, signingKey, "not-json")).rejects.toMatchObject({ status: 400 });
    const [payload, signature] = result.nextCursor!.split(".");
    const forged = { ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), lastAt: "2000-01-01T00:00:00.000Z" };
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
    await expect(readWorkspaceActivity(db, workspaceId, userId, false, signingKey, tampered)).rejects.toMatchObject({ status: 400 });
    await expect(readWorkspaceActivity(db, workspaceId, userId, false, "different-signing-key", result.nextCursor!)).rejects.toMatchObject({ status: 400 });
    const impossible = encodeActivityCursor({ ...forged, lastAt: "2099-01-01T00:00:00.000Z" }, signingKey);
    await expect(readWorkspaceActivity(db, workspaceId, userId, false, signingKey, impossible)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an old generation after repository reconnection", async () => {
    const cursor = encodeActivityCursor({ v: 1, workspaceId, connectionId: taskId, generation: 2,
      asOf: "2026-10-19T00:00:00.000Z", lastAt: "2026-10-18T00:00:00.000Z", lastSource: "TASK", lastId: eventId }, signingKey);
    const tx = { workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      gitHubConnection: { findUnique: async () => ({ id: taskId, syncGeneration: 3 }) } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    await expect(readWorkspaceActivity(db, workspaceId, userId, true, signingKey, cursor)).rejects.toMatchObject({ status: 409, code: "ACTIVITY_CHANGED" });
  });

  it("retains a historical link event after reconnecting to a different repository", async () => {
    const tx = { workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      gitHubConnection: { findUnique: async () => ({ id: taskId, syncGeneration: 3,
        lastSyncedAt: new Date("2026-10-18T00:00:00Z"), disconnectedAt: null, lastSyncError: null }) },
      taskActivity: { findMany: async () => [{ id: eventId, actorId: userId, actorLogin: "actor", taskId,
        taskTitle: "Task", kind: "GITHUB_ITEM_LINKED", occurredAt: new Date("2026-10-17T00:00:00Z"),
        details: { item: { kind: "ISSUE", number: 7, title: "Old issue",
          url: "https://github.com/old/repo/issues/7", repository: "old/repo" } } }] },
      gitHubActivity: { findMany: async () => [] } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    const page = await readWorkspaceActivity(db, workspaceId, userId, true, signingKey);
    expect(page.items).toMatchObject([{ source: "TASK", kind: "GITHUB_ITEM_LINKED",
      details: { item: { repository: "old/repo" } } }]);
  });

  it("pages task and GitHub events together without duplicates", async () => {
    const at = new Date("2026-10-18T10:00:00.000Z");
    const taskRows = Array.from({ length: 20 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      actorId: userId, actorLogin: "actor", taskId, taskTitle: "Task", kind: "TASK_UPDATED", details: {}, occurredAt: at,
    }));
    const githubRows = [{ id: eventId, actorLogin: "github-user", event: "opened", itemNumber: 1,
      itemTitle: "Issue", itemUrl: "https://github.com/o/r/issues/1", occurredAt: at }];
    const page = <T extends { id: string; occurredAt: Date }>(rows: T[], where: {
      occurredAt: { lte: Date }; OR?: Array<{ occurredAt: Date | { lt: Date }; id?: { lt: string } }>;
    }) => rows.filter((row) => row.occurredAt <= where.occurredAt.lte && (!where.OR || where.OR.some((condition) => {
      if (condition.occurredAt instanceof Date) return row.occurredAt.getTime() === condition.occurredAt.getTime() &&
        (!condition.id || row.id < condition.id.lt);
      return row.occurredAt < condition.occurredAt.lt;
    }))).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id));
    const tx = { workspaceMember: { findUnique: async () => ({ role: "VIEWER" }) },
      gitHubConnection: { findUnique: async () => ({ id: taskId, syncGeneration: 2, lastSyncedAt: at, disconnectedAt: null }) },
      taskActivity: { findMany: async ({ where }: { where: Parameters<typeof page>[1] }) => page(taskRows, where) },
      gitHubActivity: { findMany: async ({ where }: { where: Parameters<typeof page>[1] }) => page(githubRows, where) } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    const first = await readWorkspaceActivity(db, workspaceId, userId, true, signingKey);
    expect(first.items).toHaveLength(20);
    expect(first.items.every((item) => item.source === "TASK")).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await readWorkspaceActivity(db, workspaceId, userId, true, signingKey, first.nextCursor!);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.source).toBe("GITHUB");
    expect(second.nextCursor).toBeNull();
  });

  it("uses the current response time for freshness while retaining the page anchor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-19T11:00:00.000Z"));
      const rows = Array.from({ length: 21 }, (_, index) => ({
        id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
        actorId: userId, actorLogin: "actor", taskId, taskTitle: "Task", kind: "TASK_UPDATED", details: {},
        occurredAt: new Date("2026-10-18T10:00:00.000Z"),
      }));
      const findTasks = vi.fn(async () => rows);
      const tx = { workspaceMember: { findUnique: async () => ({ role: "VIEWER" }) },
        gitHubConnection: { findUnique: async () => ({ id: taskId, syncGeneration: 2,
          lastSyncedAt: new Date("2026-10-18T12:00:00.000Z"), disconnectedAt: null, lastSyncError: null }) },
        taskActivity: { findMany: findTasks }, gitHubActivity: { findMany: async () => [] } };
      const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
      const first = await readWorkspaceActivity(db, workspaceId, userId, true, signingKey);
      expect(first.github.snapshotStatus).toBe("fresh");
      expect(first.nextCursor).toBeTruthy();
      vi.setSystemTime(new Date("2026-10-19T13:00:00.000Z"));
      const second = await readWorkspaceActivity(db, workspaceId, userId, true, signingKey, first.nextCursor!);
      expect(second.github.snapshotStatus).toBe("stale");
      expect(findTasks.mock.calls[1]?.[0].where.occurredAt.lte).toEqual(new Date("2026-10-19T11:00:00.000Z"));
    } finally { vi.useRealTimers(); }
  });
});

describe("task event transaction", () => {
  it("changes the task revision for status, assignment, and due-date edits", () => {
    const task = { id: taskId, title: "Task", description: null, status: "TODO", priority: "MEDIUM",
      dueDate: null, assigneeId: null };
    const revision = taskRevision(task);
    expect(taskRevision({ ...task })).toBe(revision);
    expect(taskRevision({ ...task, status: "IN_PROGRESS" })).not.toBe(revision);
    expect(taskRevision({ ...task, dueDate: new Date("2026-10-25T00:00:00Z") })).not.toBe(revision);
    expect(taskRevision({ ...task, assigneeId: userId })).not.toBe(revision);
  });

  it("rolls back task creation when its event insert fails", async () => {
    let persisted = false;
    const tx = { $queryRaw: async () => [], workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      task: { create: async () => { persisted = true; return { id: taskId, title: "Task", description: null,
        status: "TODO", priority: "MEDIUM", dueDate: null, assigneeId: null }; } },
      user: { findUniqueOrThrow: async () => ({ githubLogin: "actor" }) },
      taskActivity: { create: async () => { throw new Error("event insert failed"); } } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => {
      try { return await action(tx); } catch (error) { persisted = false; throw error; }
    } } as unknown as PrismaClient;
    await expect(createTask(db, workspaceId, userId, { title: "Task" })).rejects.toThrow("event insert failed");
    expect(persisted).toBe(false);
  });

  it("does not write or emit an event for a no-op PATCH", async () => {
    const task = { id: taskId, title: "Task", description: null, status: "TODO", priority: "MEDIUM", dueDate: null, assigneeId: null };
    const update = vi.fn(); const create = vi.fn();
    const tx = { $queryRaw: async () => [], workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      task: { findFirst: async () => task, updateMany: update }, taskActivity: { create } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    expect(await updateTask(db, workspaceId, taskId, userId, { expectedRevision: taskRevision(task), status: "TODO" })).toEqual(task);
    expect(update).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("emits one update event with the fields actually saved", async () => {
    const before = { id: taskId, title: "Before", description: null, status: "TODO", priority: "MEDIUM",
      dueDate: null, assigneeId: null };
    const after = { ...before, title: "After", status: "IN_PROGRESS", dueDate: new Date("2026-10-25T00:00:00Z") };
    const create = vi.fn(async ({ data }) => data);
    const update = vi.fn(async () => ({ count: 1 }));
    const tx = { $queryRaw: async () => [], workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      task: { findFirst: async () => before, findFirstOrThrow: async () => after, updateMany: update },
      user: { findUniqueOrThrow: async () => ({ githubLogin: "actor" }) }, taskActivity: { create } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    await updateTask(db, workspaceId, taskId, userId, { expectedRevision: taskRevision(before), title: "After", status: "IN_PROGRESS", dueDate: "2026-10-25" });
    expect(update).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "TASK_UPDATED", actorId: userId,
      taskTitle: "After", details: { changes: [
        { field: "title", before: "Before", after: "After" },
        { field: "status", before: "TODO", after: "IN_PROGRESS" },
        { field: "dueDate", before: null, after: "2026-10-25" },
      ] } }) });
  });

  it("rejects a stale task edit before writing the task or its activity event", async () => {
    const before = { id: taskId, title: "Newer work", description: null, status: "IN_PROGRESS", priority: "MEDIUM",
      dueDate: null, assigneeId: null };
    const update = vi.fn(); const create = vi.fn();
    const tx = { $queryRaw: async () => [], workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      task: { findFirst: async () => before, updateMany: update }, taskActivity: { create } };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => action(tx) } as unknown as PrismaClient;
    await expect(updateTask(db, workspaceId, taskId, userId, { expectedRevision: taskRevision({ ...before, title: "Old work" }),
      title: "My change" })).rejects.toMatchObject({ status: 409, code: "TASK_CHANGED" });
    expect(update).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("records link and unlink transitions once and rolls back a failed event insert", async () => {
    const itemId = "66666666-6666-4666-8666-666666666666";
    const linkId = "77777777-7777-4777-8777-777777777777";
    const trace: string[] = [];
    let savedLink: { id: string; taskId: string; itemId: string; unlinkedAt: Date | null } | null = null;
    let failEvent = true;
    const events: Array<{ kind: string; details: unknown }> = [];
    const item = { id: itemId, kind: "ISSUE", number: 7, title: "Issue seven", htmlUrl: "https://github.com/o/r/issues/7" };
    const tx = { $queryRaw: async (strings: TemplateStringsArray, id: string) => {
      expect(id).toBe(workspaceId);
      const sql = strings.join("?");
      if (sql.includes('"Workspace"')) trace.push("workspace lock");
      else {
        expect(sql).toContain('FROM "GitHubConnection"');
        expect(sql).toContain('"workspaceId" = ?::uuid FOR SHARE');
        trace.push("connection lock");
      }
      return [];
    }, workspaceMember: { findUnique: async () => ({ role: "MEMBER" }) },
      task: { findFirst: async () => ({ id: taskId, title: "Task" }) },
      gitHubConnection: { findUnique: async () => { trace.push("connection read");
        return { id: eventId, syncGeneration: 2, disconnectedAt: null, fullName: "o/r" }; } },
      gitHubItem: { findFirst: async () => { trace.push("item read"); return item; } },
      taskGitHubLink: {
        findUnique: async () => savedLink,
        upsert: async () => { savedLink = { id: linkId, taskId, itemId, unlinkedAt: null }; return savedLink; },
        findFirst: async () => { trace.push("link read");
          return savedLink && !savedLink.unlinkedAt ? { ...savedLink, task: { title: "Task" }, item } : null; },
        updateMany: async () => { if (!savedLink) return { count: 0 }; savedLink.unlinkedAt = new Date(); return { count: 1 }; },
      },
      user: { findUniqueOrThrow: async () => ({ githubLogin: "actor" }) },
      taskActivity: { create: async ({ data }: { data: { kind: string; details: unknown } }) => {
        if (failEvent) throw new Error("event insert failed");
        events.push(data); return data;
      } },
    };
    const db = { $transaction: async (action: (value: unknown) => Promise<unknown>) => {
      const prior = savedLink ? { ...savedLink } : null; const priorCount = events.length;
      try { return await action(tx); } catch (error) { savedLink = prior; events.length = priorCount; throw error; }
    } } as unknown as PrismaClient;
    await expect(linkTaskGitHubItem(db, workspaceId, taskId, itemId, userId)).rejects.toThrow("event insert failed");
    expect(savedLink).toBeNull();
    failEvent = false;
    trace.length = 0;
    await linkTaskGitHubItem(db, workspaceId, taskId, itemId, userId);
    expect(trace).toEqual(["workspace lock", "connection lock", "connection read", "item read"]);
    await linkTaskGitHubItem(db, workspaceId, taskId, itemId, userId);
    expect(events.map((event) => event.kind)).toEqual(["GITHUB_ITEM_LINKED"]);
    trace.length = 0;
    await unlinkTaskGitHubItem(db, workspaceId, taskId, linkId, userId);
    expect(trace).toEqual(["workspace lock", "connection lock", "connection read", "link read"]);
    expect(events.map((event) => event.kind)).toEqual(["GITHUB_ITEM_LINKED", "GITHUB_ITEM_UNLINKED"]);
    expect(events[1]?.details).toMatchObject({ item: { repository: "o/r", number: 7 } });
  });
});
