import type { PrismaClient } from "@patchwork/db";
import type { CreateTaskInput, CreateWorkspaceInput, UpdateTaskInput, WorkspaceRole } from "@patchwork/contracts";
import { createHash } from "node:crypto";
import { HttpError } from "./http.js";
import { changedFields, writeTaskActivity } from "./activity-services.js";

export async function requireWorkspaceMember(db: Pick<PrismaClient, "workspaceMember">, workspaceId: string, userId: string): Promise<WorkspaceRole> {
  const membership = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!membership) throw new HttpError(404, "NOT_FOUND", "Workspace not found");
  return membership.role;
}

// Serialize membership changes and task assignment checks for one workspace.
export async function lockWorkspace(db: Pick<PrismaClient, "$queryRaw">, workspaceId: string): Promise<void> {
  await db.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId}::uuid FOR UPDATE`;
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

export function taskRevision(task: { id: string; title: string; description: string | null; status: string;
  priority: string; dueDate: Date | null; assigneeId: string | null }): string {
  return createHash("sha256").update(JSON.stringify([task.id, task.title, task.description, task.status,
    task.priority, task.dueDate?.toISOString().slice(0, 10) ?? null, task.assigneeId])).digest("hex");
}

export async function createTask(db: PrismaClient, workspaceId: string, userId: string, input: CreateTaskInput) {
  return db.$transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const role = await requireWorkspaceMember(transaction, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot create tasks");
    if (input.assigneeId) {
      const assignee = await transaction.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
      });
      if (!assignee) throw new HttpError(400, "INVALID_ASSIGNEE", "Assignee must belong to this workspace");
    }
    const task = await transaction.task.create({ data: {
      workspaceId, title: input.title, description: input.description,
      status: input.status ?? "TODO", priority: input.priority ?? "MEDIUM",
      dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null,
      assigneeId: input.assigneeId, createdById: userId,
    } });
    await writeTaskActivity(transaction, { workspaceId, taskId: task.id, actorId: userId,
      taskTitle: task.title, kind: "TASK_CREATED", details: { changes: changedFields({
        title: "", description: null, status: "", priority: "", dueDate: null, assigneeId: null,
      }, task) } });
    return task;
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
  return { items: tasks.slice(0, 20).map((task) => ({ ...task, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
    revision: taskRevision(task) })), nextCursor };
}

export async function updateTask(db: PrismaClient, workspaceId: string, taskId: string, userId: string, input: UpdateTaskInput) {
  return db.$transaction(async (transaction) => {
    await lockWorkspace(transaction, workspaceId);
    const role = await requireWorkspaceMember(transaction, workspaceId, userId);
    if (role === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewer cannot edit tasks");
    if (input.assigneeId) {
      const assignee = await transaction.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
      });
      if (!assignee) throw new HttpError(400, "INVALID_ASSIGNEE", "Assignee must belong to this workspace");
    }
    const before = await transaction.task.findFirst({ where: { id: taskId, workspaceId } });
    if (!before) throw new HttpError(404, "NOT_FOUND", "Task not found");
    if (taskRevision(before) !== input.expectedRevision) {
      throw new HttpError(409, "TASK_CHANGED", "This task changed since you loaded it. Reload tasks before saving.");
    }
    const next = {
      title: input.title ?? before.title,
      description: input.description === undefined ? before.description : input.description || null,
      status: input.status ?? before.status,
      priority: input.priority ?? before.priority,
      dueDate: input.dueDate === undefined ? before.dueDate : input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null,
      assigneeId: input.assigneeId === undefined ? before.assigneeId : input.assigneeId,
    };
    const changes = changedFields(before, next);
    if (changes.length === 0) return before;
    const updated = await transaction.task.updateMany({
      where: { id: taskId, workspaceId },
      data: next,
    });
    if (updated.count !== 1) throw new HttpError(404, "NOT_FOUND", "Task not found");
    const task = await transaction.task.findFirstOrThrow({ where: { id: taskId, workspaceId } });
    await writeTaskActivity(transaction, { workspaceId, taskId, actorId: userId, taskTitle: task.title,
      kind: "TASK_UPDATED", details: { changes } });
    return task;
  });
}
