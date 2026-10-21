import type { PrismaClient } from "@patchwork/db";
import { activityCursorSchema, type TaskActivityChange, type WorkspaceActivityItem, type WorkspaceActivityPage } from "@patchwork/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "./http.js";
import { requireWorkspaceMember } from "./services.js";

const PAGE_SIZE = 20;
const cursorShape = z.strictObject({
  v: z.literal(1), workspaceId: z.uuid(), connectionId: z.uuid().nullable(), generation: z.number().int().nonnegative().nullable(),
  asOf: z.iso.datetime(), lastAt: z.iso.datetime(), lastSource: z.enum(["TASK", "GITHUB"]), lastId: z.uuid(),
});
type Cursor = z.infer<typeof cursorShape>;
type EventDetails = Extract<WorkspaceActivityItem, { source: "TASK" }>["details"];

export async function writeTaskActivity(tx: Pick<PrismaClient, "user" | "taskActivity">, input: {
  workspaceId: string; taskId: string; actorId: string; taskTitle: string;
  kind: "TASK_CREATED" | "TASK_UPDATED" | "GITHUB_ITEM_LINKED" | "GITHUB_ITEM_UNLINKED";
  details: EventDetails;
}) {
  const actor = await tx.user.findUniqueOrThrow({ where: { id: input.actorId }, select: { githubLogin: true } });
  return tx.taskActivity.create({ data: { ...input, actorLogin: actor.githubLogin, occurredAt: new Date() } });
}

function cursorSignature(payload: string, signingKey: string): Buffer {
  return createHmac("sha256", signingKey).update("patchwork:workspace-activity:v1:").update(payload).digest();
}

function decodeCursor(value: unknown, signingKey: string): Cursor {
  try {
    const [payload, signature] = activityCursorSchema.parse(value).split(".");
    if (!payload || !signature) throw new Error("Invalid cursor");
    const provided = Buffer.from(signature, "base64url");
    const expected = cursorSignature(payload, signingKey);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Invalid cursor signature");
    const cursor = cursorShape.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (new Date(cursor.lastAt) > new Date(cursor.asOf)) throw new Error("Invalid cursor time");
    return cursor;
  }
  catch { throw new HttpError(400, "INVALID_CURSOR", "Activity cursor is invalid"); }
}

export function encodeActivityCursor(cursor: Cursor, signingKey: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${cursorSignature(payload, signingKey).toString("base64url")}`;
}

export function compareActivity(a: WorkspaceActivityItem, b: WorkspaceActivityItem): number {
  const time = b.occurredAt.localeCompare(a.occurredAt);
  if (time) return time;
  const rank = (b.source === "TASK" ? 1 : 0) - (a.source === "TASK" ? 1 : 0);
  return rank || b.id.localeCompare(a.id);
}

function olderThan(cursor: Cursor | null, source: "TASK" | "GITHUB") {
  if (!cursor) return {};
  const lastAt = new Date(cursor.lastAt);
  const sourceRank = source === "TASK" ? 1 : 0;
  const lastRank = cursor.lastSource === "TASK" ? 1 : 0;
  return { OR: [
    { occurredAt: { lt: lastAt } },
    ...(sourceRank < lastRank ? [{ occurredAt: lastAt }] : []),
    ...(sourceRank === lastRank ? [{ occurredAt: lastAt, id: { lt: cursor.lastId } }] : []),
  ] };
}

export async function readWorkspaceActivity(db: PrismaClient, workspaceId: string, userId: string,
  githubConfigured: boolean, signingKey: string, cursorValue?: unknown): Promise<WorkspaceActivityPage> {
  return db.$transaction(async (tx) => {
    await requireWorkspaceMember(tx, workspaceId, userId);
    const cursor = cursorValue === undefined ? null : decodeCursor(cursorValue, signingKey);
    if (cursor && cursor.workspaceId !== workspaceId) throw new HttpError(400, "INVALID_CURSOR", "Activity cursor is invalid");
    const connection = await tx.gitHubConnection.findUnique({ where: { workspaceId } });
    const connectionId = connection?.id ?? null;
    const generation = connection?.syncGeneration ?? null;
    if (cursor && (cursor.connectionId !== connectionId || cursor.generation !== generation)) {
      throw new HttpError(409, "ACTIVITY_CHANGED", "Repository activity changed; reload the timeline");
    }
    const asOf = cursor ? new Date(cursor.asOf) : new Date();
    if (asOf.getTime() > Date.now() + 1000) throw new HttpError(400, "INVALID_CURSOR", "Activity cursor is invalid");
    const [taskRows, githubRows] = await Promise.all([
      tx.taskActivity.findMany({ where: { workspaceId, occurredAt: { lte: asOf }, ...olderThan(cursor, "TASK") },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1 }),
      connection?.lastSyncedAt ? tx.gitHubActivity.findMany({ where: {
        connectionId: connection.id, syncGeneration: connection.syncGeneration,
        occurredAt: { lte: asOf }, ...olderThan(cursor, "GITHUB"),
      }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1 }) : Promise.resolve([]),
    ]);
    const combined: WorkspaceActivityItem[] = [
      ...taskRows.map((row) => ({ id: row.id, source: "TASK" as const, occurredAt: row.occurredAt.toISOString(),
        actorId: row.actorId, actorLogin: row.actorLogin, taskId: row.taskId, taskTitle: row.taskTitle,
        kind: row.kind, details: row.details as EventDetails })),
      ...githubRows.map((row) => ({ id: row.id, source: "GITHUB" as const, occurredAt: row.occurredAt.toISOString(),
        actorLogin: row.actorLogin, event: row.event, itemNumber: row.itemNumber,
        itemTitle: row.itemTitle, itemUrl: row.itemUrl })),
    ].sort(compareActivity);
    const items = combined.slice(0, PAGE_SIZE);
    const last = items.at(-1);
    const nextCursor = combined.length > PAGE_SIZE && last ? encodeActivityCursor({
      v: 1, workspaceId, connectionId, generation, asOf: asOf.toISOString(),
      lastAt: last.occurredAt, lastSource: last.source, lastId: last.id,
    }, signingKey) : null;
    const lastSyncedAt = connection?.lastSyncedAt ?? null;
    const responseTime = new Date();
    const snapshotStatus = !lastSyncedAt ? "unavailable" : responseTime.getTime() - lastSyncedAt.getTime() > 24 * 60 * 60 * 1000 ? "stale" : "fresh";
    const reason = !connection ? "No repository is connected" : !lastSyncedAt ? "No saved GitHub snapshot is available" :
      connection.disconnectedAt ? "The repository is disconnected; showing saved activity" :
      !githubConfigured ? "GitHub App configuration is unavailable; showing saved activity" :
      connection.lastSyncError ? "The latest GitHub refresh failed; showing saved activity" :
      snapshotStatus === "stale" ? "The saved GitHub snapshot is over 24 hours old" : null;
    return { items, nextCursor, github: { snapshotStatus, lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      refreshAvailable: Boolean(connection && !connection.disconnectedAt && githubConfigured), reason } };
  }, { isolationLevel: "RepeatableRead" });
}

export function changedFields(before: {
  title: string; description: string | null; status: string; priority: string; dueDate: Date | null; assigneeId: string | null;
}, after: {
  title: string; description: string | null; status: string; priority: string; dueDate: Date | null; assigneeId: string | null;
}): TaskActivityChange[] {
  const fields = ["title", "description", "status", "priority", "dueDate", "assigneeId"] as const;
  return fields.flatMap((field) => {
    const oldValue = field === "dueDate" ? before.dueDate?.toISOString().slice(0, 10) ?? null : before[field];
    const newValue = field === "dueDate" ? after.dueDate?.toISOString().slice(0, 10) ?? null : after[field];
    if (oldValue === newValue) return [];
    return [field === "description" ? { field } : { field, before: oldValue, after: newValue }];
  });
}
