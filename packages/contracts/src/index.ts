import { z } from "zod";

export const workspaceRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
export const taskPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const createWorkspaceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(3).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  timeZone: z.string().trim().min(1).max(100).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const createInvitationSchema = z.strictObject({
  githubLogin: z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "Enter a GitHub username"),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const updateMemberRoleSchema = z.strictObject({ role: workspaceRoleSchema });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid invitation token");

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.iso.date().optional(),
  assigneeId: z.uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(5000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.iso.date().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
}).refine((input) => [input.title, input.description, input.status, input.priority, input.dueDate, input.assigneeId]
  .some((value) => value !== undefined), "At least one task field is required");
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const activityCursorSchema = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export type TaskActivityField = "title" | "description" | "status" | "priority" | "dueDate" | "assigneeId";
export type TaskActivityChange = { field: TaskActivityField; before?: string | null; after?: string | null };
export type WorkspaceActivityItem = {
  id: string;
  source: "TASK" | "GITHUB";
  occurredAt: string;
  actorLogin: string | null;
} & ({
  source: "TASK";
  kind: "TASK_CREATED" | "TASK_UPDATED" | "GITHUB_ITEM_LINKED" | "GITHUB_ITEM_UNLINKED";
  actorId: string;
  taskId: string;
  taskTitle: string;
  details: { changes?: TaskActivityChange[]; item?: {
    kind: "ISSUE" | "PULL_REQUEST"; number: number; title: string; url: string; repository: string;
  } };
} | {
  source: "GITHUB";
  event: string;
  itemNumber: number;
  itemTitle: string;
  itemUrl: string;
});
export type WorkspaceActivityPage = {
  items: WorkspaceActivityItem[];
  nextCursor: string | null;
  github: { snapshotStatus: "unavailable" | "fresh" | "stale"; lastSyncedAt: string | null;
    refreshAvailable: boolean; reason: string | null };
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiSuccess<T> = { data: T };

export type HealthFinding = {
  id: string;
  rule: "OVERDUE_TASK" | "STALE_PULL_REQUEST" | "REVIEW_IDLE" | "WORKLOAD_IMBALANCE";
  severity: "WARNING" | "CRITICAL";
  title: string;
  explanation: string;
  evidence: { label: string; value: string }[];
  suggestedAction: string;
};

export type HealthReport = {
  evaluatedAt: string;
  workspaceTimeZone: string;
  github: {
    snapshotStatus: "unavailable" | "fresh" | "stale";
    lastSyncedAt: string | null;
    refreshAvailable: boolean;
    reason: string | null;
  };
  taskCounts: { total: number; unfinished: number; unassigned: number };
  findings: HealthFinding[];
};

export const connectRepositorySchema = z.strictObject({
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "Use owner/repository"),
});
export type ConnectRepositoryInput = z.infer<typeof connectRepositorySchema>;
export const startRepositoryConnectionSchema = connectRepositorySchema.extend({ workspaceId: z.uuid() });

export const createTaskGitHubLinkSchema = z.strictObject({ itemId: z.uuid() });
export type CreateTaskGitHubLinkInput = z.infer<typeof createTaskGitHubLinkSchema>;
