-- Preserve repository history while allowing a workspace to disconnect and reconnect.
ALTER TABLE "GitHubConnection" ADD COLUMN "disconnectedAt" TIMESTAMP(3),
ADD COLUMN "syncGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "GitHubItem" ADD COLUMN "syncGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GitHubActivity" ADD COLUMN "syncGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TaskGitHubLink" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "linkedById" UUID NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMP(3),
    CONSTRAINT "TaskGitHubLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskGitHubLink_taskId_itemId_key" ON "TaskGitHubLink"("taskId", "itemId");
CREATE INDEX "TaskGitHubLink_workspaceId_unlinkedAt_idx" ON "TaskGitHubLink"("workspaceId", "unlinkedAt");
ALTER TABLE "TaskGitHubLink" ADD CONSTRAINT "TaskGitHubLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskGitHubLink" ADD CONSTRAINT "TaskGitHubLink_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "GitHubItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskGitHubLink" ADD CONSTRAINT "TaskGitHubLink_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
