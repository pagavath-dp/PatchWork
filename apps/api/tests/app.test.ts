import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@patchwork/db";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { OAuthGateway } from "../src/oauth.js";
import { sha256 } from "../src/oauth.js";
import type { GitHubGateway, RepositorySnapshot } from "../src/github.js";
import { HttpError } from "../src/http.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
if (!process.env.TEST_DATABASE_URL) throw new Error("Missing TEST_DATABASE_URL");
const db = createPrismaClient(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:3000";
const config: AppConfig = {
  appOrigin: origin, callbackUrl: `${origin}/auth/github/callback`,
  githubClientId: "test-client-id", githubClientSecret: "test-client-secret", secureCookies: false,
};
const oauth: OAuthGateway = {
  authorizationUrl(state, challenge) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "read:user");
    return url.toString();
  },
  async exchangeCode() { return "mock-access-token"; },
  async fetchProfile() { return { id: 12345, login: "student", name: "Student", email: null, avatar_url: null }; },
};

async function createUserSession(githubId: string) {
  const uniqueId = `${githubId.slice(0, 10)}-${randomBytes(8).toString("hex")}`;
  const user = await db.user.create({ data: { githubId: uniqueId, githubLogin: `student-${uniqueId}` } });
  const token = `test-token-${uniqueId}`;
  await db.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60_000) } });
  return { user, cookie: `patchwork_session=${token}`, token };
}

function uniqueSlug(prefix: string): string { return `${prefix}-${randomBytes(6).toString("hex")}`; }
afterAll(async () => { await db.$disconnect(); });

describe("Milestone 1 API", () => {
  it("rejects unauthenticated and cross-workspace requests", async () => {
    const app = createApp(db, oauth, config);
    expect((await request(app).get("/api/v1/workspaces")).status).toBe(401);
    const a = await createUserSession("1");
    const b = await createUserSession("2");
    const created = await request(app).post("/api/v1/workspaces").set("Origin", origin).set("Cookie", a.cookie)
      .send({ name: "Team A", slug: uniqueSlug("team-a") });
    expect(created.status).toBe(201);
    const workspaceId = created.body.data.id as string;
    expect((await request(app).get("/api/v1/workspaces").set("Cookie", b.cookie)).body.data).toEqual([]);
    expect((await request(app).get(`/api/v1/workspaces/${workspaceId}/tasks`).set("Cookie", b.cookie)).status).toBe(404);
    expect((await request(app).post(`/api/v1/workspaces/${workspaceId}/tasks`).set("Origin", origin).set("Cookie", b.cookie).send({ title: "Intrusion" })).status).toBe(404);
    expect(await db.workspaceMember.count({ where: { workspaceId, userId: a.user.id, role: "OWNER" } })).toBe(1);
  });

  it("validates input, origin, assignee membership, and viewer role", async () => {
    const app = createApp(db, oauth, config);
    const a = await createUserSession("1");
    const b = await createUserSession("2");
    const workspace = await db.workspace.create({ data: { name: "Team", slug: uniqueSlug("team"), ownerId: a.user.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: a.user.id, role: "OWNER" } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: b.user.id, role: "VIEWER" } });
    const url = `/api/v1/workspaces/${workspace.id}/tasks`;
    expect((await request(app).post(url).set("Cookie", a.cookie).send({ title: "No origin" })).status).toBe(403);
    expect((await request(app).post(url).set("Origin", origin).set("Cookie", a.cookie).send({ title: "" })).status).toBe(400);
    expect((await request(app).post(url).set("Origin", origin).set("Cookie", a.cookie).send({ title: "Task", dueDate: "2026-02-30" })).status).toBe(400);
    const outsider = await createUserSession("3");
    expect((await request(app).post(url).set("Origin", origin).set("Cookie", a.cookie).send({ title: "Task", assigneeId: outsider.user.id })).status).toBe(400);
    expect((await request(app).post(url).set("Origin", origin).set("Cookie", b.cookie).send({ title: "Viewer write" })).status).toBe(403);
    expect(await db.task.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it("persists a task across application instances", async () => {
    const a = await createUserSession("1");
    const first = createApp(db, oauth, config);
    const createdWorkspace = await request(first).post("/api/v1/workspaces").set("Origin", origin).set("Cookie", a.cookie)
      .send({ name: "Team", slug: uniqueSlug("team") });
    const workspaceId = createdWorkspace.body.data.id as string;
    const createdTask = await request(first).post(`/api/v1/workspaces/${workspaceId}/tasks`).set("Origin", origin).set("Cookie", a.cookie)
      .send({ title: "Build foundation", dueDate: "2026-10-20" });
    expect(createdTask.status).toBe(201);
    const second = createApp(db, oauth, config);
    const listed = await request(second).get(`/api/v1/workspaces/${workspaceId}/tasks`).set("Cookie", a.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toMatchObject([{ id: createdTask.body.data.id, title: "Build foundation", dueDate: "2026-10-20" }]);
  });

  it("uses state and PKCE and rejects an invalid callback", async () => {
    const app = createApp(db, oauth, config);
    const sessionsBefore = await db.session.count();
    const started = await request(app).get("/auth/github/start");
    expect(started.status).toBe(302);
    const url = new URL(started.headers.location as string);
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    const cookies = (started.headers["set-cookie"] as unknown as string[]).map((cookie) => cookie.split(";")[0]);
    const bad = await request(app).get("/auth/github/callback?code=code&state=wrong").set("Cookie", cookies);
    expect(bad.status).toBe(400);
    expect(await db.session.count()).toBe(sessionsBefore);
  });

  it("creates a hashed server session after a valid callback", async () => {
    const app = createApp(db, oauth, config);
    const started = await request(app).get("/auth/github/start");
    const state = new URL(started.headers.location as string).searchParams.get("state");
    const cookies = (started.headers["set-cookie"] as unknown as string[]).map((cookie) => cookie.split(";")[0]);
    const finished = await request(app).get(`/auth/github/callback?code=code&state=${state}`).set("Cookie", cookies);
    expect(finished.status).toBe(302);
    const sessionCookie = (finished.headers["set-cookie"] as unknown as string[]).find((cookie) => cookie.startsWith("patchwork_session="));
    expect(sessionCookie).toBeTruthy();
    const token = sessionCookie!.split(";")[0]!.split("=")[1]!;
    const saved = await db.session.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(saved.tokenHash).toBe(sha256(token));
    expect(saved.tokenHash).not.toBe(token);
    const me = await request(app).get("/api/v1/me").set("Cookie", sessionCookie!.split(";")[0]!);
    expect(me.status).toBe(200);
    expect(me.body.data.githubLogin).toBe("student");
  });

  it("rejects expired sessions and revokes a session on logout", async () => {
    const app = createApp(db, oauth, config);
    const a = await createUserSession("1");
    await db.session.update({ where: { tokenHash: sha256(a.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get("/api/v1/me").set("Cookie", a.cookie)).status).toBe(401);
    await db.session.update({ where: { tokenHash: sha256(a.token) }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    expect((await request(app).post("/auth/logout").set("Origin", origin).set("Cookie", a.cookie)).status).toBe(200);
    expect((await request(app).get("/api/v1/me").set("Cookie", a.cookie)).status).toBe(401);
  });

  it("creates and edits tasks only for authorized workspace members", async () => {
    const app = createApp(db, oauth, config);
    const owner = await createUserSession("owner");
    const outsider = await createUserSession("outsider");
    const viewer = await createUserSession("viewer");
    const first = await request(app).post("/api/v1/workspaces").set("Origin", origin).set("Cookie", owner.cookie)
      .send({ name: "Task Team", slug: uniqueSlug("task-team") });
    expect(first.status).toBe(201);
    const workspaceId = first.body.data.id as string;
    const second = await request(app).post("/api/v1/workspaces").set("Origin", origin).set("Cookie", owner.cookie)
      .send({ name: "Other Team", slug: uniqueSlug("other-team") });
    expect(second.status).toBe(201);
    const otherWorkspaceId = second.body.data.id as string;
    await db.workspaceMember.create({ data: { workspaceId, userId: viewer.user.id, role: "VIEWER" } });
    const collection = `/api/v1/workspaces/${workspaceId}/tasks`;
    expect((await request(app).get(collection)).status).toBe(401);
    expect((await request(app).post(collection).set("Origin", origin).send({ title: "No session" })).status).toBe(401);
    const created = await request(app).post(collection).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "  Prepare demo  ", description: "First draft", status: "TODO", priority: "HIGH" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ title: "Prepare demo", description: "First draft", status: "TODO", priority: "HIGH" });
    const taskId = created.body.data.id as string;
    const expectedRevision = created.body.data.revision as string;
    const item = `${collection}/${taskId}`;
    const listed = await request(app).get(collection).set("Cookie", owner.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toContainEqual(expect.objectContaining({ id: taskId, title: "Prepare demo" }));
    expect((await request(app).get(collection).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).patch(item).set("Origin", origin).send({ status: "DONE" })).status).toBe(401);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", outsider.cookie).send({ status: "DONE", expectedRevision })).status).toBe(404);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", viewer.cookie).send({ status: "DONE", expectedRevision })).status).toBe(403);
    expect((await request(app).patch(item).set("Cookie", owner.cookie).send({ status: "DONE" })).status).toBe(403);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", owner.cookie).send({})).status).toBe(400);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", owner.cookie).send({ title: "  " })).status).toBe(400);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", owner.cookie).send({ status: "INVALID" })).status).toBe(400);
    expect((await request(app).patch(item).set("Origin", origin).set("Cookie", owner.cookie).send({ ownerId: outsider.user.id })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/workspaces/${otherWorkspaceId}/tasks/${taskId}`).set("Origin", origin).set("Cookie", owner.cookie).send({ status: "DONE", expectedRevision })).status).toBe(404);
    const updated = await request(app).patch(item).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "Demo ready", description: "", status: "IN_REVIEW", priority: "URGENT", expectedRevision });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id: taskId, title: "Demo ready", description: null, status: "IN_REVIEW", priority: "URGENT" });
    const stored = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(stored).toMatchObject({ workspaceId, title: "Demo ready", description: null, status: "IN_REVIEW", priority: "URGENT" });
    expect((await request(app).get(`/api/v1/workspaces/${otherWorkspaceId}/tasks`).set("Cookie", owner.cookie)).body.data.items).toEqual([]);
  });

  it("persists Kanban status transitions and blocks unauthorized moves", async () => {
    const app = createApp(db, oauth, config);
    const owner = await createUserSession("board-owner");
    const member = await createUserSession("board-member");
    const viewer = await createUserSession("board-viewer");
    const outsider = await createUserSession("outsider");
    const createdWorkspace = await request(app).post("/api/v1/workspaces").set("Origin", origin).set("Cookie", owner.cookie)
      .send({ name: "Board Team", slug: uniqueSlug("board-team") });
    expect(createdWorkspace.status).toBe(201);
    const workspaceId = createdWorkspace.body.data.id as string;
    await db.workspaceMember.createMany({ data: [
      { workspaceId, userId: member.user.id, role: "MEMBER" },
      { workspaceId, userId: viewer.user.id, role: "VIEWER" },
    ] });
    const createdTask = await request(app).post(`/api/v1/workspaces/${workspaceId}/tasks`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "Move on board", priority: "HIGH" });
    expect(createdTask.status).toBe(201);
    const taskId = createdTask.body.data.id as string;
    let expectedRevision = createdTask.body.data.revision as string;
    const taskUrl = `/api/v1/workspaces/${workspaceId}/tasks/${taskId}`;
    expect((await request(app).patch(taskUrl).set("Origin", origin).send({ status: "IN_PROGRESS" })).status).toBe(401);
    expect((await request(app).patch(taskUrl).set("Origin", origin).set("Cookie", outsider.cookie).send({ status: "IN_PROGRESS", expectedRevision })).status).toBe(404);
    expect((await request(app).patch(taskUrl).set("Origin", origin).set("Cookie", viewer.cookie).send({ status: "IN_PROGRESS", expectedRevision })).status).toBe(403);
    expect((await request(app).patch(taskUrl).set("Origin", origin).set("Cookie", member.cookie).send({ status: "INVALID" })).status).toBe(400);
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("TODO");
    for (const status of ["IN_PROGRESS", "IN_REVIEW", "DONE", "TODO"] as const) {
      const moved = await request(app).patch(taskUrl).set("Origin", origin).set("Cookie", member.cookie).send({ status, expectedRevision });
      expect(moved.status).toBe(200);
      expectedRevision = moved.body.data.revision as string;
      expect(moved.body.data).toMatchObject({ id: taskId, status });
      const listed = await request(app).get(`/api/v1/workspaces/${workspaceId}/tasks`).set("Cookie", viewer.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body.data.items).toContainEqual(expect.objectContaining({ id: taskId, status }));
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(status);
    }
  });

  it("edits and clears due dates and assignees with workspace checks", async () => {
    const app = createApp(db, oauth, config);
    const owner = await createUserSession("edit-owner");
    const member = await createUserSession("edit-member");
    const outsider = await createUserSession("edit-outsider");
    const workspace = await db.workspace.create({ data: { name: "Edit Team", slug: uniqueSlug("edit-team"), ownerId: owner.user.id } });
    await db.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" },
      { workspaceId: workspace.id, userId: member.user.id, role: "MEMBER" },
    ] });
    const created = await request(app).post(`/api/v1/workspaces/${workspace.id}/tasks`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "Edit metadata" });
    expect(created.status).toBe(201);
    const path = `/api/v1/workspaces/${workspace.id}/tasks/${created.body.data.id}`;
    expect((await request(app).patch(path).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ assigneeId: outsider.user.id, expectedRevision: created.body.data.revision })).status).toBe(400);
    expect((await request(app).patch(path).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ dueDate: "2026-02-30", expectedRevision: created.body.data.revision })).status).toBe(400);
    const updated = await request(app).patch(path).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ dueDate: "2026-11-20", assigneeId: member.user.id, expectedRevision: created.body.data.revision });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ dueDate: "2026-11-20", assigneeId: member.user.id });
    const listed = await request(app).get(`/api/v1/workspaces/${workspace.id}/tasks`).set("Cookie", member.cookie);
    expect(listed.body.data.items).toContainEqual(expect.objectContaining({ id: created.body.data.id, dueDate: "2026-11-20", assigneeId: member.user.id }));
    const cleared = await request(app).patch(path).set("Origin", origin).set("Cookie", member.cookie)
      .send({ dueDate: null, assigneeId: null, expectedRevision: updated.body.data.revision });
    expect(cleared.body.data).toMatchObject({ dueDate: null, assigneeId: null });
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/members`).set("Cookie", outsider.cookie)).status).toBe(404);
  });
});

describe("workspace health API", () => {
  it("requires authentication and membership, permits viewer reads, and reports missing GitHub data", async () => {
    const owner = await createUserSession("health-owner");
    const viewer = await createUserSession("health-viewer");
    const outsider = await createUserSession("health-outsider");
    const workspace = await db.workspace.create({ data: {
      name: "Health Team", slug: uniqueSlug("health-team"), ownerId: owner.user.id, timeZone: "UTC",
    } });
    await db.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" },
      { workspaceId: workspace.id, userId: viewer.user.id, role: "VIEWER" },
    ] });
    await db.task.create({ data: { workspaceId: workspace.id, title: "Overdue work", createdById: owner.user.id,
      dueDate: new Date("2020-01-01T00:00:00.000Z"), status: "TODO" } });
    const app = createApp(db, oauth, config);
    const path = `/api/v1/workspaces/${workspace.id}/health`;
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set("Cookie", outsider.cookie)).status).toBe(404);
    const read = await request(app).get(path).set("Cookie", viewer.cookie);
    expect(read.status).toBe(200);
    expect(read.body.data.github).toMatchObject({ snapshotStatus: "unavailable", refreshAvailable: false });
    expect(read.body.data.findings).toMatchObject([{ rule: "OVERDUE_TASK", severity: "CRITICAL" }]);
    expect(read.body.data.findings[0].evidence).toContainEqual({ label: "Due date", value: "2020-01-01" });
  });

  it("assesses only the current saved PR snapshot without GitHub App configuration", async () => {
    const owner = await createUserSession("health-cache");
    const workspace = await db.workspace.create({ data: {
      name: "Cached Health", slug: uniqueSlug("cached-health"), ownerId: owner.user.id,
    } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" } });
    const connection = await db.gitHubConnection.create({ data: {
      workspaceId: workspace.id, installationId: "81", repositoryId: "9001", owner: "student", name: "repo",
      fullName: "student/repo", htmlUrl: "https://github.com/student/repo", defaultBranch: "main",
      isPrivate: false, connectedById: owner.user.id, lastSyncedAt: new Date(Date.now() - 2 * 86_400_000),
      syncGeneration: 1,
    } });
    await db.gitHubItem.createMany({ data: [
      { connectionId: connection.id, githubId: "current-pr", syncGeneration: 1, number: 5,
        kind: "PULL_REQUEST", title: "Needs attention", state: "open",
        htmlUrl: "https://github.com/student/repo/pull/5", createdAt: new Date(Date.now() - 20 * 86_400_000),
        updatedAt: new Date(Date.now() - 10 * 86_400_000) },
      { connectionId: connection.id, githubId: "old-pr", syncGeneration: 0, number: 4,
        kind: "PULL_REQUEST", title: "Old generation", state: "open",
        htmlUrl: "https://github.com/student/repo/pull/4", createdAt: new Date(Date.now() - 30 * 86_400_000),
        updatedAt: new Date(Date.now() - 20 * 86_400_000) },
    ] });
    const read = await request(createApp(db, oauth, config)).get(`/api/v1/workspaces/${workspace.id}/health`)
      .set("Cookie", owner.cookie);
    expect(read.status).toBe(200);
    expect(read.body.data.github).toMatchObject({ snapshotStatus: "stale", refreshAvailable: false,
      reason: "GitHub App configuration is missing; live refresh is unavailable." });
    expect(read.body.data.findings.map((finding: { id: string }) => finding.id)).toHaveLength(1);
    expect(read.body.data.findings[0]).toMatchObject({ rule: "STALE_PULL_REQUEST", severity: "WARNING" });
  });
});

describe("GitHub repository integration", () => {
  const githubConfig: AppConfig = { ...config, githubApp: {
    appId: "1", clientId: "app-client", clientSecret: "test-only", privateKeyPath: "/nonexistent",
    slug: "patchwork-test", callbackUrl: `${origin}/auth/github-app/callback`,
  } };
  const snapshot: RepositorySnapshot = {
    repository: { id: 9001, name: "repo", full_name: "student/repo", owner: { login: "student" },
      html_url: "https://github.com/student/repo", description: "A test repository", default_branch: "main", private: true },
    issues: [{ id: 101, number: 1, title: "Fix issue", state: "open", html_url: "https://github.com/student/repo/issues/1",
      user: { login: "student" }, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" }],
    pulls: [{ id: 102, number: 2, title: "Review PR", state: "open", html_url: "https://github.com/student/repo/pull/2",
      user: { login: "student" }, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-16T00:00:00Z", draft: false, merged_at: null }],
    events: [{ id: 103, event: "review_requested", created_at: "2026-10-16T00:00:00Z", actor: { login: "student" },
      issue: { number: 2, title: "Review PR", html_url: "https://github.com/student/repo/pull/2" } }],
  };
  const gateway: GitHubGateway = {
    authorizationUrl(state) { return `https://github.com/login/oauth/authorize?state=${state}`; },
    async exchangeCode() { return "test-user-token"; },
    async verifyUserRepository() { return { installationId: "81", repositoryId: "9001" }; },
    async fetchSnapshot() { return snapshot; },
  };

  it("requires configuration and validates connection input and workspace role", async () => {
    const owner = await createUserSession("github-owner");
    const member = await createUserSession("github-member");
    const outsider = await createUserSession("github-outsider");
    const workspace = await db.workspace.create({ data: { name: "GitHub Team", slug: uniqueSlug("github-team"), ownerId: owner.user.id } });
    await db.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" },
      { workspaceId: workspace.id, userId: member.user.id, role: "MEMBER" },
    ] });
    const path = "/auth/github-app/start";
    const input = { workspaceId: workspace.id, repository: "student/repo" };
    expect((await request(createApp(db, oauth, config)).post(path).set("Origin", origin).set("Cookie", owner.cookie).send(input)).status).toBe(503);
    expect((await request(createApp(db, oauth, config)).post(path).set("Origin", origin).set("Cookie", member.cookie).send(input)).status).toBe(403);
    expect((await request(createApp(db, oauth, config)).post(path).set("Origin", origin).set("Cookie", outsider.cookie).send(input)).status).toBe(404);
    const app = createApp(db, oauth, githubConfig, gateway);
    expect((await request(app).post(path).set("Origin", origin).send(input)).status).toBe(401);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", outsider.cookie).send(input)).status).toBe(404);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", member.cookie).send(input)).status).toBe(403);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", owner.cookie).send({ ...input, repository: "bad" })).status).toBe(400);
    expect((await request(app).post(path).set("Cookie", owner.cookie).send(input)).status).toBe(403);
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/repository`).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).post(`/api/v1/workspaces/${workspace.id}/repository/refresh`).set("Origin", origin).set("Cookie", member.cookie)).status).toBe(403);
    expect((await request(app).post(`/api/v1/workspaces/${workspace.id}/repository/refresh`).set("Origin", origin).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(createApp(db, oauth, config)).post(`/api/v1/workspaces/${workspace.id}/repository/refresh`).set("Origin", origin).set("Cookie", member.cookie)).status).toBe(403);
  });

  it("connects through a verified callback, persists snapshots, and protects refresh", async () => {
    const owner = await createUserSession("repo-owner");
    const viewer = await createUserSession("repo-viewer");
    const outsider = await createUserSession("repo-outsider");
    const workspace = await db.workspace.create({ data: { name: "Repo Team", slug: uniqueSlug("repo-team"), ownerId: owner.user.id } });
    await db.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" },
      { workspaceId: workspace.id, userId: viewer.user.id, role: "VIEWER" },
    ] });
    const app = createApp(db, oauth, githubConfig, gateway);
    const startPath = "/auth/github-app/start";
    const started = await request(app).post(startPath).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ workspaceId: workspace.id, repository: "student/repo" });
    expect(started.status).toBe(200);
    const state = new URL(started.body.data.authorizationUrl as string).searchParams.get("state");
    const cookies = (started.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";")[0]);
    const callback = "/auth/github-app/callback?code=code&state=";
    expect((await request(app).get(`${callback}wrong`).set("Cookie", [owner.cookie, ...cookies])).status).toBe(400);
    expect(await db.gitHubConnection.count({ where: { workspaceId: workspace.id } })).toBe(0);
    const connected = await request(app).get(`${callback}${state}`).set("Cookie", [owner.cookie, ...cookies]);
    expect(connected.status).toBe(302);
    expect(await db.gitHubConnection.count({ where: { workspaceId: workspace.id } })).toBe(1);
    const path = `/api/v1/workspaces/${workspace.id}/repository`;
    const read = await request(app).get(path).set("Cookie", viewer.cookie);
    expect(read.status).toBe(200);
    expect(read.body.data.repository.issues).toHaveLength(1);
    expect(read.body.data.repository.pulls).toHaveLength(1);
    expect(read.body.data.repository.activities).toHaveLength(3);
    expect(read.body.data.repository.connection.installationId).toBeUndefined();
    const withoutApp = await request(createApp(db, oauth, config)).get(path).set("Cookie", viewer.cookie);
    expect(withoutApp.status).toBe(200);
    expect(withoutApp.body.data.configured).toBe(false);
    expect(withoutApp.body.data.repository.connection.fullName).toBe("student/repo");
    expect(withoutApp.body.data.repository.issues).toHaveLength(1);
    expect(withoutApp.body.data.repository.pulls).toHaveLength(1);
    expect(withoutApp.body.data.repository.activities).toHaveLength(3);
    expect((await request(app).get(path).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).post(`${path}/refresh`).set("Origin", origin).set("Cookie", viewer.cookie)).status).toBe(403);
    expect((await request(app).post(`${path}/refresh`).set("Cookie", owner.cookie)).status).toBe(403);
    expect((await request(app).post(`${path}/refresh`).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(200);
    const rateLimited: GitHubGateway = { ...gateway, async fetchSnapshot() {
      throw new HttpError(503, "GITHUB_RATE_LIMITED", "GitHub API rate limit reached; try again later");
    } };
    const failed = await request(createApp(db, oauth, githubConfig, rateLimited)).post(`${path}/refresh`)
      .set("Origin", origin).set("Cookie", owner.cookie);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("GITHUB_RATE_LIMITED");
    const cached = await request(app).get(path).set("Cookie", viewer.cookie);
    expect(cached.body.data.repository.issues).toHaveLength(1);
    expect(cached.body.data.repository.connection.lastSyncError).toContain("rate limit");
    expect((await request(app).post(startPath).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ workspaceId: workspace.id, repository: "student/repo" })).status).toBe(409);
  });

  it("keeps cached records on disconnect, reconnects, and validates task links", async () => {
    const owner = await createUserSession("link-owner");
    const viewer = await createUserSession("link-viewer");
    const outsider = await createUserSession("link-outsider");
    const workspace = await db.workspace.create({ data: { name: "Links", slug: uniqueSlug("links"), ownerId: owner.user.id } });
    const other = await db.workspace.create({ data: { name: "Other", slug: uniqueSlug("other"), ownerId: owner.user.id } });
    await db.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" },
      { workspaceId: workspace.id, userId: viewer.user.id, role: "VIEWER" },
      { workspaceId: other.id, userId: owner.user.id, role: "OWNER" },
    ] });
    const app = createApp(db, oauth, githubConfig, gateway);
    const connect = async () => {
      const started = await request(app).post("/auth/github-app/start").set("Origin", origin).set("Cookie", owner.cookie)
        .send({ workspaceId: workspace.id, repository: "student/repo" });
      expect(started.status).toBe(200);
      const state = new URL(started.body.data.authorizationUrl as string).searchParams.get("state");
      const cookies = (started.headers["set-cookie"] as unknown as string[]).map((value) => value.split(";")[0]);
      return request(app).get(`/auth/github-app/callback?code=code&state=${state}`).set("Cookie", [owner.cookie, ...cookies]);
    };
    expect((await connect()).status).toBe(302);
    const task = await request(app).post(`/api/v1/workspaces/${workspace.id}/tasks`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "Linked task" });
    const otherTask = await request(app).post(`/api/v1/workspaces/${other.id}/tasks`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ title: "Other task" });
    await db.gitHubConnection.create({ data: { workspaceId: other.id, installationId: "82", repositoryId: "9002",
      owner: "other", name: "repo", fullName: "other/repo", htmlUrl: "https://github.com/other/repo",
      defaultBranch: "main", isPrivate: false, connectedById: owner.user.id } });
    const item = await db.gitHubItem.findFirstOrThrow({ where: { connection: { workspaceId: workspace.id }, kind: "ISSUE" } });
    const path = `/api/v1/workspaces/${workspace.id}/tasks/${task.body.data.id}/github-links`;
    expect((await request(app).post(path).set("Origin", origin).send({ itemId: item.id })).status).toBe(401);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", outsider.cookie).send({ itemId: item.id })).status).toBe(404);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", viewer.cookie).send({ itemId: item.id })).status).toBe(403);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", owner.cookie).send({ itemId: "bad" })).status).toBe(400);
    expect((await request(app).post(`/api/v1/workspaces/${other.id}/tasks/${otherTask.body.data.id}/github-links`)
      .set("Origin", origin).set("Cookie", owner.cookie).send({ itemId: item.id })).status).toBe(400);
    const linked = await request(app).post(path).set("Origin", origin).set("Cookie", owner.cookie).send({ itemId: item.id });
    expect(linked.status).toBe(201);
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/github-links`).set("Cookie", viewer.cookie)).body.data)
      .toContainEqual(expect.objectContaining({ id: linked.body.data.id, taskId: task.body.data.id }));
    const repositoryPath = `/api/v1/workspaces/${workspace.id}/repository`;
    expect((await request(app).post(`${repositoryPath}/disconnect`).set("Origin", origin).set("Cookie", viewer.cookie)).status).toBe(403);
    expect((await request(app).post(`${repositoryPath}/disconnect`).set("Origin", origin).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).post(`${repositoryPath}/disconnect`).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(200);
    expect((await request(app).post(`${repositoryPath}/refresh`).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(404);
    expect((await request(app).post(path).set("Origin", origin).set("Cookie", owner.cookie).send({ itemId: item.id })).status).toBe(409);
    expect(await db.gitHubItem.count({ where: { id: item.id } })).toBe(1);
    expect((await connect()).status).toBe(302);
    const connection = await db.gitHubConnection.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
    expect(connection.syncGeneration).toBe(1);
    expect(connection.disconnectedAt).toBeNull();
    const unlinked = await request(app).post(`${path}/${linked.body.data.id}/unlink`).set("Origin", origin).set("Cookie", owner.cookie);
    expect(unlinked.status).toBe(200);
    expect(await db.taskGitHubLink.count({ where: { id: linked.body.data.id } })).toBe(1);
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/github-links`).set("Cookie", owner.cookie)).body.data).toEqual([]);
  });

  it("pages cached issues, pull requests, and activity within one workspace", async () => {
    const owner = await createUserSession("page-owner");
    const outsider = await createUserSession("page-outsider");
    const workspace = await db.workspace.create({ data: { name: "Pages", slug: uniqueSlug("pages"), ownerId: owner.user.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" } });
    const connection = await db.gitHubConnection.create({ data: { workspaceId: workspace.id, installationId: "1", repositoryId: "9001",
      owner: "student", name: "repo", fullName: "student/repo", htmlUrl: "https://github.com/student/repo",
      defaultBranch: "main", isPrivate: false, connectedById: owner.user.id } });
    const now = new Date();
    await db.gitHubItem.createMany({ data: [...Array.from({ length: 32 }, (_, i) => ({ connectionId: connection.id,
      githubId: String(1000 + i), number: i + 1, kind: "ISSUE" as const, title: `Issue ${i + 1}`, state: "open",
      htmlUrl: `https://github.com/student/repo/issues/${i + 1}`, createdAt: now, updatedAt: now })),
    ...Array.from({ length: 32 }, (_, i) => ({ connectionId: connection.id,
      githubId: String(2000 + i), number: i + 1, kind: "PULL_REQUEST" as const, title: `PR ${i + 1}`, state: "open",
      htmlUrl: `https://github.com/student/repo/pull/${i + 1}`, createdAt: now, updatedAt: now }))] });
    await db.gitHubActivity.createMany({ data: Array.from({ length: 52 }, (_, i) => ({ connectionId: connection.id,
      githubId: String(3000 + i), event: "opened", itemNumber: i + 1, itemTitle: `Issue ${i + 1}`,
      itemUrl: `https://github.com/student/repo/issues/${i + 1}`, occurredAt: now })) });
    const app = createApp(db, oauth, githubConfig, gateway);
    const base = `/api/v1/workspaces/${workspace.id}/repository`;
    const first = await request(app).get(base).set("Cookie", owner.cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.repository.issues).toHaveLength(30);
    expect(first.body.data.repository.pulls).toHaveLength(30);
    expect(first.body.data.repository.activities).toHaveLength(50);
    for (const [kind, key] of [["ISSUE", "issuesNextCursor"], ["PULL_REQUEST", "pullsNextCursor"]] as const) {
      const cursor = first.body.data.repository[key] as string;
      expect(cursor).toBeTruthy();
      const next = await request(app).get(`${base}/items?kind=${kind}&cursor=${cursor}`).set("Cookie", owner.cookie);
      expect(next.status).toBe(200);
      expect(next.body.data.items).toHaveLength(2);
      expect(next.body.data.nextCursor).toBeNull();
    }
    const activity = await request(app).get(`${base}/activity?cursor=${first.body.data.repository.activitiesNextCursor}`).set("Cookie", owner.cookie);
    expect(activity.status).toBe(200);
    expect(activity.body.data.items).toHaveLength(2);
    expect((await request(app).get(`${base}/items?kind=ISSUE`).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).get(`${base}/activity`).set("Cookie", outsider.cookie)).status).toBe(404);
  });
});

describe("workspace invitations and membership", () => {
  async function fixture() {
    const owner = await createUserSession("invite-owner");
    const recipient = await createUserSession("invite-recipient");
    const outsider = await createUserSession("invite-outsider");
    const workspace = await db.workspace.create({ data: { name: "Invited Team", slug: uniqueSlug("invited"), ownerId: owner.user.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.user.id, role: "OWNER" } });
    const app = createApp(db, oauth, config, undefined, async (login) => ({ githubId: recipient.user.githubId, login }));
    const base = `/api/v1/workspaces/${workspace.id}`;
    const create = (role = "MEMBER") => request(app).post(`${base}/invitations`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ githubLogin: recipient.user.githubLogin, role });
    return { owner, recipient, outsider, workspace, app, base, create };
  }

  it("validates the recipient and grants only the authenticated intended account", async () => {
    const { owner, recipient, outsider, workspace, app, base, create } = await fixture();
    expect((await request(app).post(`${base}/invitations`).set("Origin", origin)
      .send({ githubLogin: recipient.user.githubLogin, role: "MEMBER" })).status).toBe(401);
    expect((await request(app).post(`${base}/invitations`).set("Origin", origin).set("Cookie", outsider.cookie)
      .send({ githubLogin: recipient.user.githubLogin, role: "MEMBER" })).status).toBe(404);
    expect((await request(app).post(`${base}/invitations`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ githubLogin: "invalid login", role: "MEMBER" })).status).toBe(400);
    const created = await create();
    expect(created.status).toBe(201);
    const token = created.body.data.token as string;
    const saved = await db.workspaceInvitation.findUniqueOrThrow({ where: { id: created.body.data.id as string } });
    expect(saved.tokenHash).toBe(sha256(token));
    expect(saved.tokenHash).not.toBe(token);
    expect(saved.recipientGithubId).toBe(recipient.user.githubId);
    expect((await create()).status).toBe(409);
    expect((await request(app).get(`${base}/invitations`).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).get(`${base}/invitations`).set("Cookie", owner.cookie)).body.data[0].token).toBeUndefined();
    const invitePath = `/api/v1/invitations/${token}`;
    expect((await request(app).get(invitePath).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).post(`${invitePath}/accept`).set("Origin", origin).set("Cookie", outsider.cookie)).status).toBe(404);
    expect((await request(app).get(invitePath).set("Cookie", recipient.cookie)).status).toBe(200);
    expect((await request(app).post(`${invitePath}/accept`).set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(200);
    expect((await request(app).post(`${invitePath}/accept`).set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(409);
    expect(await db.workspaceMember.count({ where: { workspaceId: workspace.id, userId: recipient.user.id } })).toBe(1);
    expect((await request(app).get("/api/v1/workspaces").set("Cookie", recipient.cookie)).body.data)
      .toContainEqual(expect.objectContaining({ id: workspace.id, role: "MEMBER" }));
    expect((await request(app).get(`${base}/tasks`).set("Cookie", recipient.cookie)).status).toBe(200);
    expect((await request(app).get(`${base}/repository`).set("Cookie", recipient.cookie)).status).toBe(200);
  });

  it("rejects expired and revoked invitations and makes rejection final", async () => {
    const { owner, recipient, app, base, create } = await fixture();
    const expired = await create();
    await db.workspaceInvitation.update({ where: { id: expired.body.data.id as string }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post(`/api/v1/invitations/${expired.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(410);
    const revoked = await create();
    expect((await request(app).post(`${base}/invitations/${revoked.body.data.id}/revoke`)
      .set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(200);
    expect((await request(app).post(`/api/v1/invitations/${revoked.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(409);
    const rejected = await create();
    expect((await request(app).post(`/api/v1/invitations/${rejected.body.data.token}/reject`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(200);
    expect((await request(app).post(`/api/v1/invitations/${rejected.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(409);
  });

  it("accepts at most once under competing requests", async () => {
    const { recipient, workspace, app, create } = await fixture();
    const created = await create();
    const path = `/api/v1/invitations/${created.body.data.token}/accept`;
    const results = await Promise.all([1, 2].map(() => request(app).post(path).set("Origin", origin).set("Cookie", recipient.cookie)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await db.workspaceMember.count({ where: { workspaceId: workspace.id, userId: recipient.user.id } })).toBe(1);
  });

  it("enforces role management and retains at least one owner", async () => {
    const { owner, recipient, outsider, workspace, app, base, create } = await fixture();
    const outsiderApp = createApp(db, oauth, config, undefined, async (login) => ({ githubId: outsider.user.githubId, login }));
    const pendingAdmin = await request(outsiderApp).post(`${base}/invitations`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ githubLogin: outsider.user.githubLogin, role: "ADMIN" });
    expect(pendingAdmin.status).toBe(201);
    const invited = await create("ADMIN");
    expect((await request(app).post(`/api/v1/invitations/${invited.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(200);
    const rolePath = `${base}/members/${owner.user.id}`;
    expect((await request(app).patch(rolePath).set("Origin", origin).set("Cookie", recipient.cookie)
      .send({ role: "VIEWER" })).status).toBe(403);
    expect((await request(app).patch(rolePath).set("Origin", origin).set("Cookie", outsider.cookie)
      .send({ role: "VIEWER" })).status).toBe(404);
    expect((await request(app).patch(rolePath).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ role: "MEMBER" })).status).toBe(409);
    expect((await request(app).delete(rolePath).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(409);
    expect((await request(app).patch(`${base}/members/${recipient.user.id}`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ role: "OWNER" })).status).toBe(200);
    expect((await request(app).patch(rolePath).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ role: "MEMBER" })).status).toBe(200);
    expect((await db.workspaceInvitation.findUniqueOrThrow({ where: { id: pendingAdmin.body.data.id as string } })).status).toBe("REVOKED");
    expect((await request(outsiderApp).post(`/api/v1/invitations/${pendingAdmin.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", outsider.cookie)).status).toBe(409);
    expect((await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).ownerId).toBe(recipient.user.id);
    expect((await request(app).patch(`${base}/members/${recipient.user.id}`).set("Origin", origin).set("Cookie", owner.cookie)
      .send({ role: "VIEWER" })).status).toBe(403);
    expect((await request(app).delete(`${base}/members/${owner.user.id}`).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(200);
  });

  it("blocks removal of an assigned member and viewer writes", async () => {
    const { owner, recipient, workspace, app, base, create } = await fixture();
    const invited = await create("VIEWER");
    expect((await request(app).post(`/api/v1/invitations/${invited.body.data.token}/accept`)
      .set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(200);
    expect((await request(app).post(`${base}/invitations`).set("Origin", origin).set("Cookie", recipient.cookie)
      .send({ githubLogin: "someone", role: "MEMBER" })).status).toBe(403);
    expect((await request(app).patch(`${base}/members/${recipient.user.id}`).set("Origin", origin).set("Cookie", recipient.cookie)
      .send({ role: "OWNER" })).status).toBe(403);
    expect((await request(app).delete(`${base}/members/${recipient.user.id}`).set("Origin", origin).set("Cookie", recipient.cookie)).status).toBe(403);
    await db.task.create({ data: { workspaceId: workspace.id, title: "Assigned", createdById: owner.user.id, assigneeId: recipient.user.id } });
    expect((await request(app).delete(`${base}/members/${recipient.user.id}`).set("Origin", origin).set("Cookie", owner.cookie)).status).toBe(409);
    expect(await db.workspaceMember.count({ where: { workspaceId: workspace.id, userId: recipient.user.id } })).toBe(1);
  });
});
