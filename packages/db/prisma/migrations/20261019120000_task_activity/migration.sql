-- Add append-only task activity without changing existing tasks or snapshots.
CREATE TYPE "TaskActivityKind" AS ENUM ('TASK_CREATED', 'TASK_UPDATED', 'GITHUB_ITEM_LINKED', 'GITHUB_ITEM_UNLINKED');

CREATE TABLE "TaskActivity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "actorLogin" VARCHAR(100) NOT NULL,
    "taskTitle" VARCHAR(160) NOT NULL,
    "kind" "TaskActivityKind" NOT NULL,
    "details" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskActivity_workspaceId_occurredAt_id_idx" ON "TaskActivity"("workspaceId", "occurredAt", "id");
CREATE INDEX "TaskActivity_taskId_occurredAt_idx" ON "TaskActivity"("taskId", "occurredAt");
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
