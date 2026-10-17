import type { PrismaClient } from "@patchwork/db";
import type { GitHubGateway, RepositorySnapshot } from "./github.js";
import { HttpError } from "./http.js";
import { requireWorkspaceMember } from "./services.js";

export async function requireManager(db: Pick<PrismaClient, "workspaceMember">, workspaceId: string, userId: string) {
  const role = await requireWorkspaceMember(db, workspaceId, userId);
  if (role !== "OWNER" && role !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "Only workspace owners and admins can manage GitHub integration");
}

export async function canConnectRepository(db: PrismaClient, workspaceId: string, userId: string) {
  await requireManager(db, workspaceId, userId);
  if (await db.gitHubConnection.findUnique({ where: { workspaceId }, select: { disconnectedAt: true } }).then((value) => value && !value.disconnectedAt)) {
    throw new HttpError(409, "REPOSITORY_CONNECTED", "This workspace already has a connected repository");
  }
}

async function storeSnapshot(tx: Pick<PrismaClient, "gitHubConnection" | "gitHubItem" | "gitHubActivity">, connectionId: string, generation: number, snapshot: RepositorySnapshot) {
    const repo = snapshot.repository;
    await tx.gitHubConnection.update({ where: { id: connectionId }, data: {
      owner: repo.owner.login, name: repo.name, fullName: repo.full_name,
      description: repo.description, htmlUrl: repo.html_url, defaultBranch: repo.default_branch,
      isPrivate: repo.private, lastSyncedAt: new Date(), lastSyncError: null,
    } });
    for (const [kind, items] of [["ISSUE", snapshot.issues], ["PULL_REQUEST", snapshot.pulls]] as const) {
      for (const item of items) {
        const data = { syncGeneration: generation, number: item.number, kind, title: item.title, state: item.state,
          htmlUrl: item.html_url, authorLogin: item.user?.login ?? null,
          createdAt: new Date(item.created_at), updatedAt: new Date(item.updated_at) };
        await tx.gitHubItem.upsert({ where: { connectionId_githubId: { connectionId, githubId: String(item.id) } },
          create: { connectionId, githubId: String(item.id), ...data }, update: data });
      }
    }
    for (const event of snapshot.events) {
      if (!event.issue) continue;
      const data = { syncGeneration: generation, event: event.event, itemNumber: event.issue.number, itemTitle: event.issue.title,
        itemUrl: event.issue.html_url, actorLogin: event.actor?.login ?? null, occurredAt: new Date(event.created_at) };
      await tx.gitHubActivity.upsert({ where: { connectionId_githubId: { connectionId, githubId: String(event.id) } },
        create: { connectionId, githubId: String(event.id), ...data }, update: data });
    }
    for (const [prefix, items] of [["issue", snapshot.issues], ["pr", snapshot.pulls]] as const) {
      for (const item of items) {
        const githubId = `${prefix}:${item.id}`;
        const data = { syncGeneration: generation, event: "opened", itemNumber: item.number, itemTitle: item.title,
          itemUrl: item.html_url, actorLogin: item.user?.login ?? null, occurredAt: new Date(item.created_at) };
        await tx.gitHubActivity.upsert({ where: { connectionId_githubId: { connectionId, githubId } },
          create: { connectionId, githubId, ...data }, update: data });
      }
    }
}

export async function connectRepository(db: PrismaClient, gateway: GitHubGateway, workspaceId: string, userId: string,
  repository: string, installationId: string, repositoryId: string) {
  await canConnectRepository(db, workspaceId, userId);
  const snapshot = await gateway.fetchSnapshot(installationId, repositoryId, repository);
  if (String(snapshot.repository.id) !== repositoryId || snapshot.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new HttpError(403, "GITHUB_REPOSITORY_MISMATCH", "GitHub returned a different repository");
  }
  // Recheck authorization immediately before the database write.
  await canConnectRepository(db, workspaceId, userId);
  return db.$transaction(async (tx) => {
    const role = await requireWorkspaceMember(tx, workspaceId, userId);
    if (role !== "OWNER" && role !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "Only workspace owners and admins can manage GitHub integration");
    const previous = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    if (previous && !previous.disconnectedAt) throw new HttpError(409, "REPOSITORY_CONNECTED", "This workspace already has a connected repository");
    const generation = previous ? previous.syncGeneration + 1 : 0;
    const data = { installationId, repositoryId, owner: snapshot.repository.owner.login,
      name: snapshot.repository.name, fullName: snapshot.repository.full_name,
      description: snapshot.repository.description, htmlUrl: snapshot.repository.html_url,
      defaultBranch: snapshot.repository.default_branch, isPrivate: snapshot.repository.private,
      connectedById: userId, connectedAt: new Date(), disconnectedAt: null, syncGeneration: generation };
    let connection;
    if (previous) {
      const claimed = await tx.gitHubConnection.updateMany({
        where: { id: previous.id, workspaceId, disconnectedAt: previous.disconnectedAt,
          syncGeneration: previous.syncGeneration, installationId: previous.installationId,
          repositoryId: previous.repositoryId },
        data,
      });
      if (claimed.count !== 1) throw new HttpError(409, "REPOSITORY_CONNECTED", "Repository connection changed during reconnect");
      connection = { ...previous, ...data };
    } else {
      connection = await tx.gitHubConnection.create({ data: { workspaceId, ...data } });
    }
    await storeSnapshot(tx, connection.id, generation, snapshot);
    return connection;
  }, { timeout: 60_000 });
}

export async function readRepository(db: PrismaClient, workspaceId: string, userId: string) {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    if (!connection) return null;
    const [issues, pulls, activities] = await Promise.all([
      tx.gitHubItem.findMany({ where: { connectionId: connection.id, syncGeneration: connection.syncGeneration, kind: "ISSUE" }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 31 }),
      tx.gitHubItem.findMany({ where: { connectionId: connection.id, syncGeneration: connection.syncGeneration, kind: "PULL_REQUEST" }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 31 }),
      tx.gitHubActivity.findMany({ where: { connectionId: connection.id, syncGeneration: connection.syncGeneration }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51 }),
    ]);
    const { installationId: _installationId, ...safeConnection } = connection;
    void _installationId;
    return { connection: safeConnection, issues: issues.slice(0, 30), pulls: pulls.slice(0, 30), activities: activities.slice(0, 50),
      issuesNextCursor: issues.length > 30 ? issues[29]!.id : null,
      pullsNextCursor: pulls.length > 30 ? pulls[29]!.id : null,
      activitiesNextCursor: activities.length > 50 ? activities[49]!.id : null };
  }, { isolationLevel: "RepeatableRead" });
}

export async function listRepositoryItems(db: PrismaClient, workspaceId: string, userId: string,
  kind: "ISSUE" | "PULL_REQUEST", cursor?: string) {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Repository is not connected");
    const where = { connectionId: connection.id, syncGeneration: connection.syncGeneration, kind };
    if (cursor && !await tx.gitHubItem.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) {
      throw new HttpError(400, "INVALID_CURSOR", "Repository item cursor is invalid");
    }
    const items = await tx.gitHubItem.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    return { items: items.slice(0, 30), nextCursor: items.length > 30 ? items[29]!.id : null };
  }, { isolationLevel: "RepeatableRead" });
}

export async function listRepositoryActivity(db: PrismaClient, workspaceId: string, userId: string, cursor?: string) {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Repository is not connected");
    const where = { connectionId: connection.id, syncGeneration: connection.syncGeneration };
    if (cursor && !await tx.gitHubActivity.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) {
      throw new HttpError(400, "INVALID_CURSOR", "Activity cursor is invalid");
    }
    const activities = await tx.gitHubActivity.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    return { items: activities.slice(0, 50), nextCursor: activities.length > 50 ? activities[49]!.id : null };
  }, { isolationLevel: "RepeatableRead" });
}

export async function refreshRepository(db: PrismaClient, gateway: GitHubGateway, workspaceId: string, userId: string) {
  await requireManager(db, workspaceId, userId);
  const connection = await db.gitHubConnection.findUnique({ where: { workspaceId } });
  if (!connection || connection.disconnectedAt) throw new HttpError(404, "NOT_FOUND", "Repository is not connected");
  try {
    const snapshot = await gateway.fetchSnapshot(connection.installationId, connection.repositoryId, connection.fullName);
    if (String(snapshot.repository.id) !== connection.repositoryId) throw new HttpError(403, "GITHUB_REPOSITORY_MISMATCH", "GitHub returned a different repository");
    await requireManager(db, workspaceId, userId);
    await db.$transaction(async (tx) => {
      const role = await requireWorkspaceMember(tx, workspaceId, userId);
      if (role !== "OWNER" && role !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "Only workspace owners and admins can manage GitHub integration");
      const nextGeneration = connection.syncGeneration + 1;
      const published = await tx.gitHubConnection.updateMany({
        where: { id: connection.id, disconnectedAt: null, syncGeneration: connection.syncGeneration,
          installationId: connection.installationId, repositoryId: connection.repositoryId },
        data: { syncGeneration: nextGeneration },
      });
      if (published.count !== 1) {
        throw new HttpError(409, "REPOSITORY_CHANGED", "Repository connection changed during refresh");
      }
      await storeSnapshot(tx, connection.id, nextGeneration, snapshot);
    }, { timeout: 60_000 });
  } catch (error) {
    if (error instanceof HttpError && error.code.startsWith("GITHUB_")) {
      await db.gitHubConnection.updateMany({ where: { id: connection.id, disconnectedAt: null, syncGeneration: connection.syncGeneration }, data: { lastSyncError: error.message } });
    }
    throw error;
  }
  return readRepository(db, workspaceId, userId);
}

export async function disconnectRepository(db: PrismaClient, workspaceId: string, userId: string) {
  await requireManager(db, workspaceId, userId);
  const changed = await db.gitHubConnection.updateMany({
    where: { workspaceId, disconnectedAt: null }, data: { disconnectedAt: new Date() },
  });
  if (changed.count !== 1) throw new HttpError(404, "NOT_FOUND", "Repository is not connected");
  return readRepository(db, workspaceId, userId);
}

export async function listTaskGitHubLinks(db: PrismaClient, workspaceId: string, userId: string) {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId }, select: { id: true, syncGeneration: true } });
    if (!connection) return [];
    const links = await tx.taskGitHubLink.findMany({
      where: { workspaceId, unlinkedAt: null,
        item: { connectionId: connection.id, syncGeneration: connection.syncGeneration } },
      include: { item: true }, orderBy: { linkedAt: "desc" },
    });
    return links.map(({ item, ...link }) => ({ ...link, item: {
      id: item.id, kind: item.kind, number: item.number, title: item.title, htmlUrl: item.htmlUrl,
    } }));
  }, { isolationLevel: "RepeatableRead" });
}

export async function linkTaskGitHubItem(db: PrismaClient, workspaceId: string, taskId: string, itemId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const role = await requireWorkspaceMember(tx, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot link tasks");
    const task = await tx.task.findFirst({ where: { id: taskId, workspaceId }, select: { id: true } });
    if (!task) throw new HttpError(404, "NOT_FOUND", "Task not found");
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    if (!connection || connection.disconnectedAt) throw new HttpError(409, "REPOSITORY_NOT_CONNECTED", "Connect a repository before linking tasks");
    const item = await tx.gitHubItem.findFirst({ where: { id: itemId, connectionId: connection.id,
      syncGeneration: connection.syncGeneration } });
    if (!item) throw new HttpError(400, "INVALID_GITHUB_ITEM", "Choose an issue or pull request from the connected repository");
    return tx.taskGitHubLink.upsert({ where: { taskId_itemId: { taskId, itemId } },
      create: { workspaceId, taskId, itemId, linkedById: userId },
      update: { unlinkedAt: null, linkedById: userId, linkedAt: new Date() },
    });
  });
}

export async function unlinkTaskGitHubItem(db: PrismaClient, workspaceId: string, taskId: string, linkId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const role = await requireWorkspaceMember(tx, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot unlink tasks");
    const changed = await tx.taskGitHubLink.updateMany({ where: { id: linkId, taskId, workspaceId, unlinkedAt: null },
      data: { unlinkedAt: new Date() } });
    if (changed.count !== 1) throw new HttpError(404, "NOT_FOUND", "Link not found");
    return { unlinked: true };
  });
}
