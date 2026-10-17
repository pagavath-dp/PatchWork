import type { PrismaClient } from "@patchwork/db";
import { evaluateHealth } from "./health-rules.js";
import { requireWorkspaceMember } from "./services.js";

export async function readWorkspaceHealth(db: PrismaClient, workspaceId: string, userId: string, githubConfigured: boolean, now = new Date()) {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const [workspace, tasks, memberships, connection] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timeZone: true } }),
      tx.task.findMany({ where: { workspaceId }, select: {
        id: true, title: true, status: true, dueDate: true, assigneeId: true, updatedAt: true,
      } }),
      tx.workspaceMember.findMany({ where: { workspaceId }, select: {
        userId: true, user: { select: { githubLogin: true, name: true } },
      } }),
      tx.gitHubConnection.findUnique({ where: { workspaceId }, select: {
        id: true, syncGeneration: true, lastSyncedAt: true, lastSyncError: true, disconnectedAt: true,
      } }),
    ]);
    const pulls = connection?.lastSyncedAt ? await tx.gitHubItem.findMany({
      where: { connectionId: connection.id, syncGeneration: connection.syncGeneration, kind: "PULL_REQUEST" },
      select: { id: true, number: true, title: true, state: true, updatedAt: true, htmlUrl: true },
    }) : [];
    return evaluateHealth({ now, timeZone: workspace.timeZone, tasks,
      members: memberships.map(({ userId, user }) => ({ userId, githubLogin: user.githubLogin, name: user.name })),
      connection, pulls, githubConfigured });
  }, { isolationLevel: "RepeatableRead" });
}
