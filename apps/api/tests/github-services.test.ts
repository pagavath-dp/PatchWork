import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@patchwork/db";
import { HttpError } from "../src/http.js";
import type { GitHubGateway, RepositorySnapshot } from "../src/github.js";
import { connectRepository, listTaskGitHubLinks, readRepository, refreshRepository } from "../src/github-services.js";

const workspaceId = "workspace-1";
const userId = "owner-1";

function snapshot(repositoryId: number, issueIds: number[], eventIds: number[]): RepositorySnapshot {
  const owner = repositoryId === 1 ? "first" : "second";
  return {
    repository: { id: repositoryId, owner: { login: owner }, name: "repo", full_name: `${owner}/repo`,
      html_url: `https://github.com/${owner}/repo`, description: null, default_branch: "main", private: false },
    issues: issueIds.map((id) => ({ id, number: id, title: `Issue ${id}`, state: "open",
      html_url: `https://github.com/${owner}/repo/issues/${id}`, user: { login: owner },
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" })),
    pulls: [],
    events: eventIds.map((id) => ({ id, event: "labeled", created_at: "2026-10-03T00:00:00Z",
      actor: { login: owner }, issue: { number: id, title: `Issue ${id}`,
        html_url: `https://github.com/${owner}/repo/issues/${id}` } })),
  };
}

function gateway(value: RepositorySnapshot | Error): GitHubGateway {
  return {
    authorizationUrl: () => "https://github.com/login/oauth/authorize",
    exchangeCode: async () => "unused",
    verifyUserRepository: async () => ({ installationId: "installation-1", repositoryId: "1" }),
    fetchSnapshot: async () => { if (value instanceof Error) throw value; return value; },
  };
}

type Connection = {
  id: string; workspaceId: string; installationId: string; repositoryId: string; fullName: string;
  syncGeneration: number; disconnectedAt: Date | null; lastSyncedAt: Date | null; lastSyncError: string | null;
  [key: string]: unknown;
};
type SavedRecord = { id: string; connectionId: string; githubId: string; syncGeneration: number; [key: string]: unknown };
type Link = { id: string; workspaceId: string; taskId: string; itemId: string; unlinkedAt: Date | null; linkedAt: Date };
type State = { connection: Connection; items: SavedRecord[]; activities: SavedRecord[]; links: Link[] };

function fakeDatabase() {
  let state: State = { connection: { id: "connection-1", workspaceId, installationId: "installation-1",
    repositoryId: "1", fullName: "first/repo", syncGeneration: 0, disconnectedAt: null,
    lastSyncedAt: new Date("2026-10-03T00:00:00Z"), lastSyncError: null },
  items: [], activities: [], links: [] };
  let failStorage = false;

  const matchingRecords = (records: SavedRecord[], where: { connectionId: string; syncGeneration: number; kind?: string }) =>
    records.filter((record) => record.connectionId === where.connectionId && record.syncGeneration === where.syncGeneration &&
      (!where.kind || record.kind === where.kind));
  const upsert = (collection: "items" | "activities") => async ({ where, create, update }: {
    where: { connectionId_githubId: { connectionId: string; githubId: string } };
    create: Record<string, unknown>; update: Record<string, unknown>;
  }) => {
    if (failStorage) throw new Error("simulated storage failure");
    const key = where.connectionId_githubId;
    const existing = state[collection].find((record) => record.connectionId === key.connectionId && record.githubId === key.githubId);
    if (existing) { Object.assign(existing, update); return existing; }
    const record = { id: `${collection}-${key.githubId}`, ...create } as SavedRecord;
    state[collection].push(record);
    return record;
  };
  const db = {
    workspaceMember: { findUnique: async () => ({ role: "OWNER" }) },
    gitHubConnection: {
      findUnique: async ({ where }: { where: { id?: string; workspaceId?: string } }) =>
        where.id === state.connection.id || where.workspaceId === state.connection.workspaceId ? state.connection : null,
      updateMany: async ({ where, data }: { where: Partial<Connection>; data: Partial<Connection> }) => {
        if (Object.entries(where).some(([key, value]) => {
          const current = state.connection[key];
          return current instanceof Date && value instanceof Date ? current.getTime() !== value.getTime() : current !== value;
        })) return { count: 0 };
        Object.assign(state.connection, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Partial<Connection> }) => { Object.assign(state.connection, data); return state.connection; },
    },
    gitHubItem: {
      upsert: upsert("items"),
      findMany: async ({ where }: { where: { connectionId: string; syncGeneration: number; kind?: string } }) =>
        matchingRecords(state.items, where),
    },
    gitHubActivity: {
      upsert: upsert("activities"),
      findMany: async ({ where }: { where: { connectionId: string; syncGeneration: number } }) =>
        matchingRecords(state.activities, where),
    },
    taskGitHubLink: {
      findMany: async ({ where }: { where: { workspaceId: string; unlinkedAt: null;
        item: { connectionId: string; syncGeneration: number } } }) => state.links.flatMap((link) => {
        const item = state.items.find((candidate) => candidate.id === link.itemId);
        return link.workspaceId === where.workspaceId && link.unlinkedAt === null && item &&
          item.connectionId === where.item.connectionId && item.syncGeneration === where.item.syncGeneration
          ? [{ ...link, item }] : [];
      }),
    },
    $transaction: async <T>(action: (transaction: PrismaClient) => Promise<T>): Promise<T> => {
      const before = structuredClone(state);
      try { return await action(db as unknown as PrismaClient); }
      catch (error) { state = before; throw error; }
    },
  };
  return { db: db as unknown as PrismaClient, state: () => state,
    failStorage: () => { failStorage = true; } };
}

function rendezvous(participants: number) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    if (++arrivals === participants) release();
    await ready;
  };
}

describe("repository snapshot publishing", () => {
  it("replaces the active item and event set after a complete refresh without deleting old rows", async () => {
    const fake = fakeDatabase();
    await refreshRepository(fake.db, gateway(snapshot(1, [10, 11], [20, 21])), workspaceId, userId);
    expect(fake.state().connection.syncGeneration).toBe(1);
    const oldItem = fake.state().items.find((item) => item.githubId === "11");
    const oldEvent = fake.state().activities.find((event) => event.githubId === "21");
    await refreshRepository(fake.db, gateway(snapshot(1, [10], [20])), workspaceId, userId);
    const active = await readRepository(fake.db, workspaceId, userId);
    expect(active?.issues.map((item) => item.githubId)).toEqual(["10"]);
    expect(active?.activities.map((event) => event.githubId).sort()).toEqual(["20", "issue:10"]);
    expect(fake.state().connection.syncGeneration).toBe(2);
    expect(oldItem?.syncGeneration).toBe(1);
    expect(oldEvent?.syncGeneration).toBe(1);
    expect(fake.state().items).toHaveLength(2);
  });

  it("keeps the previous active snapshot when fetching or storing a refresh fails", async () => {
    const fake = fakeDatabase();
    await refreshRepository(fake.db, gateway(snapshot(1, [10], [20])), workspaceId, userId);
    const before = await readRepository(fake.db, workspaceId, userId);
    await expect(refreshRepository(fake.db, gateway(new HttpError(503, "GITHUB_UNAVAILABLE", "GitHub API is unavailable")),
      workspaceId, userId)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(fake.state().connection.syncGeneration).toBe(1);
    expect((await readRepository(fake.db, workspaceId, userId))?.issues).toEqual(before?.issues);
    fake.failStorage();
    await expect(refreshRepository(fake.db, gateway(snapshot(1, [12], [22])), workspaceId, userId))
      .rejects.toThrow("simulated storage failure");
    expect(fake.state().connection.syncGeneration).toBe(1);
    expect((await readRepository(fake.db, workspaceId, userId))?.issues).toEqual(before?.issues);
  });

  it("does not show old task links after reconnecting to another repository", async () => {
    const fake = fakeDatabase();
    await refreshRepository(fake.db, gateway(snapshot(1, [10], [])), workspaceId, userId);
    const oldItem = fake.state().items.find((item) => item.githubId === "10")!;
    fake.state().links.push({ id: "link-1", workspaceId, taskId: "task-1", itemId: oldItem.id,
      unlinkedAt: null, linkedAt: new Date() });
    expect(await listTaskGitHubLinks(fake.db, workspaceId, userId)).toHaveLength(1);
    fake.state().connection.disconnectedAt = new Date();
    await connectRepository(fake.db, gateway(snapshot(2, [30], [])), workspaceId, userId,
      "second/repo", "installation-2", "2");
    expect(fake.state().connection.syncGeneration).toBe(2);
    expect((await readRepository(fake.db, workspaceId, userId))?.issues.map((item) => item.githubId)).toEqual(["30"]);
    expect(await listTaskGitHubLinks(fake.db, workspaceId, userId)).toEqual([]);
    expect(fake.state().links).toHaveLength(1);
    expect(fake.state().items.find((item) => item.id === oldItem.id)?.syncGeneration).toBe(1);
  });

  it("rolls back a claimed reconnect generation when snapshot storage fails", async () => {
    const fake = fakeDatabase();
    await refreshRepository(fake.db, gateway(snapshot(1, [10], [20])), workspaceId, userId);
    fake.state().connection.disconnectedAt = new Date("2026-10-04T00:00:00Z");
    const before = structuredClone(fake.state());
    fake.failStorage();
    await expect(connectRepository(fake.db, gateway(snapshot(2, [30], [40])), workspaceId, userId,
      "second/repo", "installation-2", "2")).rejects.toThrow("simulated storage failure");
    expect(fake.state()).toEqual(before);
  });

  it("allows only one competing reconnect to claim the disconnected generation", async () => {
    const fake = fakeDatabase();
    fake.state().connection.disconnectedAt = new Date("2026-10-04T00:00:00Z");
    const connectionDelegate = fake.db.gitHubConnection;
    const outerReadsReady = rendezvous(2);
    const transactionReadsReady = rendezvous(2);
    let outerReads = 0;
    const db = {
      ...fake.db,
      gitHubConnection: {
        ...connectionDelegate,
        findUnique: async (args: Parameters<typeof connectionDelegate.findUnique>[0]) => {
          const observed = structuredClone(await connectionDelegate.findUnique(args));
          if (++outerReads > 2) await outerReadsReady();
          return observed;
        },
      },
      $transaction: async <T>(action: (tx: PrismaClient) => Promise<T>): Promise<T> => {
        const tx = {
          ...fake.db,
          gitHubConnection: {
            ...connectionDelegate,
            findUnique: async (args: Parameters<typeof connectionDelegate.findUnique>[0]) => {
              const observed = structuredClone(await connectionDelegate.findUnique(args));
              await transactionReadsReady();
              return observed;
            },
          },
        } as unknown as PrismaClient;
        // The loser has no writes to roll back: its conditional update must fail first.
        return action(tx);
      },
    } as unknown as PrismaClient;

    const results = await Promise.allSettled([
      connectRepository(db, gateway(snapshot(1, [10], [20])), workspaceId, userId,
        "first/repo", "installation-1", "1"),
      connectRepository(db, gateway(snapshot(2, [30], [40])), workspaceId, userId,
        "second/repo", "installation-2", "2"),
    ]);
    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: { code: "REPOSITORY_CONNECTED" } });
    const active = await readRepository(fake.db, workspaceId, userId);
    expect(active?.connection.syncGeneration).toBe(1);
    expect(active?.connection.repositoryId).toBe(fake.state().connection.repositoryId);
    const expectedIssue = active?.connection.repositoryId === "1" ? "10" : "30";
    const expectedEvent = active?.connection.repositoryId === "1" ? "20" : "40";
    expect(active?.issues.map((item) => item.githubId)).toEqual([expectedIssue]);
    expect(active?.activities.map((event) => event.githubId).sort()).toEqual([expectedEvent, `issue:${expectedIssue}`].sort());
    expect(fake.state().items.filter((item) => item.syncGeneration === 1).map((item) => item.githubId)).toEqual([expectedIssue]);
  });
});
