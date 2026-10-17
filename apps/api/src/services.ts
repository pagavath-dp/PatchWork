import type { PrismaClient } from "@patchwork/db";
import type { CreateTaskInput, CreateWorkspaceInput, UpdateTaskInput, WorkspaceRole } from "@patchwork/contracts";
import { HttpError } from "./http.js";

export async function requireWorkspaceMember(db: Pick<PrismaClient, "workspaceMember">, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const membership = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!membership) throw new HttpError(404, "NOT_FOUND", "Workspace not found");
  return membership.role;
}

export async function createWorkspace(db: PrismaClient, userId: string, input: CreateWorkspaceInput) {
  if (input.timeZone) {
    try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }); }
    catch { throw new HttpError(400, "INVALID_TIME_ZONE", "Invalid time zone"); }
  }
  return db.$transaction(async (transaction) => {
    const workspace = await transaction.workspace.create({ data: {
      name: input.name, slug: input.slug, ownerId: userId, timeZone: input.timeZone ?? "UTC",
    } });
    await transaction.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role: "OWNER" } });
    return workspace;
  });
}

export async function listWorkspaces(db: PrismaClient, userId: string) {
  const memberships = await db.workspaceMember.findMany({
    where: { userId }, include: { workspace: true }, orderBy: { joinedAt: "desc" },
  });
  return memberships.map(({ role, workspace }) => ({ ...workspace, role }));
}

export async function listWorkspaceMembers(db: PrismaClient, workspaceId: string, userId: string) {
  await requireWorkspaceMember(db, workspaceId, userId);
  const members = await db.workspaceMember.findMany({
    where: { workspaceId }, include: { user: { select: { id: true, githubLogin: true, name: true } } },
    orderBy: { joinedAt: "asc" },
  });
  return members.map(({ role, user }) => ({ ...user, role }));
}

export async function createTask(db: PrismaClient, workspaceId: string, userId: string, input: CreateTaskInput) {
  return db.$transaction(async (transaction) => {
    const role = await requireWorkspaceMember(transaction, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot create tasks");
    if (input.assigneeId) {
      const assignee = await transaction.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
      });
      if (!assignee) throw new HttpError(400, "INVALID_ASSIGNEE", "Assignee must belong to this workspace");
    }
    return transaction.task.create({ data: {
      workspaceId, title: input.title, description: input.description,
      status: input.status ?? "TODO", priority: input.priority ?? "MEDIUM",
      dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null,
      assigneeId: input.assigneeId, createdById: userId,
    } });
  });
}

export async function listTasks(db: PrismaClient, workspaceId: string, userId: string, cursor?: string) {
  await requireWorkspaceMember(db, workspaceId, userId);
  if (cursor) {
    const cursorTask = await db.task.findFirst({ where: { id: cursor, workspaceId }, select: { id: true } });
    if (!cursorTask) throw new HttpError(400, "INVALID_CURSOR", "Task cursor is invalid");
  }
  const tasks = await db.task.findMany({
    where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const nextCursor = tasks.length > 20 ? tasks[19]?.id ?? null : null;
  return { items: tasks.slice(0, 20).map((task) => ({ ...task, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null })), nextCursor };
}

export async function updateTask(db: PrismaClient, workspaceId: string, taskId: string, userId: string, input: UpdateTaskInput) {
  return db.$transaction(async (transaction) => {
    const role = await requireWorkspaceMember(transaction, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot edit tasks");
    if (input.assigneeId) {
      const assignee = await transaction.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
      });
      if (!assignee) throw new HttpError(400, "INVALID_ASSIGNEE", "Assignee must belong to this workspace");
    }
    const updated = await transaction.task.updateMany({
      where: { id: taskId, workspaceId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      },
    });
    if (updated.count !== 1) throw new HttpError(404, "NOT_FOUND", "Task not found");
    return transaction.task.findFirstOrThrow({ where: { id: taskId, workspaceId } });
  });
}
