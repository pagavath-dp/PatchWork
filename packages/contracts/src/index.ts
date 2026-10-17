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
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(5000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.iso.date().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), "At least one task field is required");
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

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
