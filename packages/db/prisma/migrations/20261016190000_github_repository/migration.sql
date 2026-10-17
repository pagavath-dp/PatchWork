-- CreateEnum
CREATE TYPE "GitHubItemKind" AS ENUM ('ISSUE', 'PULL_REQUEST');

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "installationId" VARCHAR(30) NOT NULL,
    "repositoryId" VARCHAR(30) NOT NULL,
    "owner" VARCHAR(100) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "fullName" VARCHAR(201) NOT NULL,
    "description" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "defaultBranch" VARCHAR(255) NOT NULL,
    "isPrivate" BOOLEAN NOT NULL,
    "connectedById" UUID NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" VARCHAR(300),

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubItem" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "githubId" VARCHAR(30) NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "GitHubItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "state" VARCHAR(30) NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "authorLogin" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubActivity" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "githubId" VARCHAR(30) NOT NULL,
    "event" VARCHAR(80) NOT NULL,
    "itemNumber" INTEGER NOT NULL,
    "itemTitle" TEXT NOT NULL,
    "itemUrl" TEXT NOT NULL,
    "actorLogin" VARCHAR(100),
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_workspaceId_key" ON "GitHubConnection"("workspaceId");

-- CreateIndex
CREATE INDEX "GitHubItem_connectionId_kind_updatedAt_idx" ON "GitHubItem"("connectionId", "kind", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubItem_connectionId_githubId_key" ON "GitHubItem"("connectionId", "githubId");

-- CreateIndex
CREATE INDEX "GitHubActivity_connectionId_occurredAt_idx" ON "GitHubActivity"("connectionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubActivity_connectionId_githubId_key" ON "GitHubActivity"("connectionId", "githubId");

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubItem" ADD CONSTRAINT "GitHubItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitHubConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubActivity" ADD CONSTRAINT "GitHubActivity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitHubConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
