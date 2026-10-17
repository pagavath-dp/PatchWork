import { describe, expect, it } from "vitest";
import { evaluateHealth, type HealthInput, type HealthTask } from "../src/health-rules.js";

const now = new Date("2026-10-17T12:00:00.000Z");
const task = (overrides: Partial<HealthTask> = {}): HealthTask => ({
  id: "task-1", title: "Ship board", status: "TODO", dueDate: null, assigneeId: null,
  updatedAt: now, ...overrides,
});
const input = (overrides: Partial<HealthInput> = {}): HealthInput => ({
  now, timeZone: "UTC", tasks: [], members: [], connection: null, pulls: [], githubConfigured: false, ...overrides,
});

describe("project health rules", () => {
  it("does not call empty, unconfigured data healthy", () => {
    const report = evaluateHealth(input());
    expect(report.findings).toEqual([]);
    expect(report.github).toMatchObject({ snapshotStatus: "unavailable", refreshAvailable: false,
      reason: "No GitHub repository is connected." });
    expect(report.taskCounts).toEqual({ total: 0, unfinished: 0, unassigned: 0 });
  });

  it("uses workspace calendar dates and excludes due-today and completed tasks", () => {
    const report = evaluateHealth(input({ now: new Date("2026-10-17T20:00:00.000Z"), timeZone: "Asia/Kolkata",
      tasks: [task({ id: "due-today", dueDate: new Date("2026-10-18T00:00:00.000Z") }),
        task({ id: "overdue", dueDate: new Date("2026-10-17T00:00:00.000Z") }),
        task({ id: "done", status: "DONE", dueDate: new Date("2026-10-01T00:00:00.000Z") })] }));
    expect(report.findings.map((finding) => finding.id)).toEqual(["overdue:overdue"]);
    expect(report.findings[0]).toMatchObject({ severity: "WARNING", evidence: expect.arrayContaining([{ label: "Days overdue", value: "1" }]) });
  });

  it("escalates overdue and review-stage idle rules at their boundaries", () => {
    const report = evaluateHealth(input({ tasks: [
      task({ id: "late", dueDate: new Date("2026-10-14T00:00:00.000Z") }),
      task({ id: "review-early", status: "IN_REVIEW", updatedAt: new Date("2026-10-14T12:00:01.000Z") }),
      task({ id: "review-warning", status: "IN_REVIEW", updatedAt: new Date("2026-10-14T12:00:00.000Z") }),
      task({ id: "review-critical", status: "IN_REVIEW", updatedAt: new Date("2026-10-10T12:00:00.000Z") }),
    ] }));
    expect(report.findings.find((finding) => finding.id === "overdue:late")?.severity).toBe("CRITICAL");
    expect(report.findings.some((finding) => finding.id === "review:review-early")).toBe(false);
    expect(report.findings.find((finding) => finding.id === "review:review-warning")?.severity).toBe("WARNING");
    expect(report.findings.find((finding) => finding.id === "review:review-critical")?.severity).toBe("CRITICAL");
    expect(report.findings.find((finding) => finding.id === "review:review-critical")?.explanation).toContain("review decisions are not available");
  });

  it("uses only open pull requests from a saved snapshot and identifies stale snapshots", () => {
    const report = evaluateHealth(input({ githubConfigured: false,
      connection: { lastSyncedAt: new Date("2026-10-15T11:59:59.000Z"), lastSyncError: null, disconnectedAt: null },
      pulls: [
        { id: "early", number: 1, title: "Early", state: "OPEN", updatedAt: new Date("2026-10-08T12:00:00.000Z"), htmlUrl: "https://github.com/team/repo/pull/1" },
        { id: "stale", number: 2, title: "Stale", state: "open", updatedAt: new Date("2026-10-08T11:59:59.000Z"), htmlUrl: "https://github.com/team/repo/pull/2" },
        { id: "closed", number: 3, title: "Closed", state: "CLOSED", updatedAt: new Date("2026-09-01T12:00:00.000Z"), htmlUrl: "https://github.com/team/repo/pull/3" },
      ] }));
    expect(report.github).toMatchObject({ snapshotStatus: "stale", refreshAvailable: false,
      reason: "GitHub App configuration is missing; live refresh is unavailable." });
    expect(report.findings.map((finding) => finding.id)).toEqual(["pull:stale"]);
    expect(report.findings[0]?.evidence).toContainEqual({ label: "Snapshot saved", value: "2026-10-15T11:59:59.000Z" });
    expect(report.findings[0]?.evidence).toContainEqual({ label: "Idle days at snapshot", value: "7" });
  });

  it("does not infer new PR inactivity after an old snapshot", () => {
    const report = evaluateHealth(input({ githubConfigured: true,
      connection: { lastSyncedAt: new Date("2026-10-15T12:00:00.000Z"), lastSyncError: null, disconnectedAt: null },
      pulls: [{ id: "unknown-now", number: 8, title: "Possibly updated since sync", state: "OPEN",
        updatedAt: new Date("2026-10-09T12:00:00.000Z"), htmlUrl: "https://github.com/team/repo/pull/8" }] }));
    expect(report.github.snapshotStatus).toBe("stale");
    expect(report.findings).toEqual([]);
  });

  it("does not evaluate pull requests without a saved snapshot", () => {
    const report = evaluateHealth(input({ githubConfigured: true,
      connection: { lastSyncedAt: null, lastSyncError: null, disconnectedAt: null },
      pulls: [{ id: "old", number: 9, title: "Old", state: "OPEN", updatedAt: new Date("2026-09-01T00:00:00.000Z"), htmlUrl: "https://github.com/team/repo/pull/9" }] }));
    expect(report.github.snapshotStatus).toBe("unavailable");
    expect(report.findings).toEqual([]);
  });

  it("changes snapshot freshness after 24 hours and escalates a PR after 14 idle days", () => {
    const connection = { lastSyncedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      lastSyncError: null, disconnectedAt: null };
    const pull = { id: "critical", number: 10, title: "Long-running PR", state: "OPEN",
      updatedAt: new Date(now.getTime() - 15 * 86_400_000), htmlUrl: "https://github.com/team/repo/pull/10" };
    const fresh = evaluateHealth(input({ githubConfigured: true, connection, pulls: [pull] }));
    expect(fresh.github).toMatchObject({ snapshotStatus: "fresh", refreshAvailable: true });
    expect(fresh.findings[0]).toMatchObject({ rule: "STALE_PULL_REQUEST", severity: "CRITICAL" });
    const stale = evaluateHealth(input({ githubConfigured: true,
      connection: { ...connection, lastSyncedAt: new Date(connection.lastSyncedAt.getTime() - 1) }, pulls: [pull] }));
    expect(stale.github.snapshotStatus).toBe("stale");
  });

  it("flags substantial assigned-task imbalance but not equal or sparse assignments", () => {
    const members = [{ userId: "a", githubLogin: "alice", name: "Alice" }, { userId: "b", githubLogin: "bob", name: "Bob" }];
    const balanced = evaluateHealth(input({ members, tasks: [task({ id: "a1", assigneeId: "a" }), task({ id: "b1", assigneeId: "b" })] }));
    expect(balanced.findings).toEqual([]);
    const uneven = evaluateHealth(input({ members, tasks: [
      task({ id: "a1", assigneeId: "a" }), task({ id: "a2", assigneeId: "a" }), task({ id: "a3", assigneeId: "a" }),
      task({ id: "unassigned" }), task({ id: "done", status: "DONE", assigneeId: "b" }),
    ] }));
    expect(uneven.findings).toMatchObject([{ rule: "WORKLOAD_IMBALANCE", severity: "WARNING" }]);
    expect(uneven.findings[0]?.evidence).toContainEqual({ label: "Unassigned tasks", value: "1" });
  });
});
