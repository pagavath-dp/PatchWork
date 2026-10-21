import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { PrismaClient } from "@patchwork/db";
import { connectRepositorySchema, createInvitationSchema, createTaskGitHubLinkSchema, createTaskSchema, createWorkspaceSchema, invitationTokenSchema, startRepositoryConnectionSchema, updateMemberRoleSchema, updateTaskSchema } from "@patchwork/contracts";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError, requireSameOrigin, sendError } from "./http.js";
import { codeChallenge, equalTokens, randomUrlToken, type OAuthGateway } from "./oauth.js";
import { attachUser, createSession, SESSION_COOKIE } from "./session.js";
import { createTask, createWorkspace, listTasks, listWorkspaceMembers, listWorkspaces, taskRevision, updateTask } from "./services.js";
import { createGitHubGateway, requireGitHubApp, type GitHubGateway } from "./github.js";
import { canConnectRepository, connectRepository, disconnectRepository, linkTaskGitHubItem, listRepositoryActivity, listRepositoryItems, listTaskGitHubLinks, readRepository, refreshRepository, requireManager, unlinkTaskGitHubItem } from "./github-services.js";
import { requireWorkspaceMember } from "./services.js";
import { readWorkspaceHealth } from "./health-services.js";
import { createInvitation, listInvitations, readInvitation, removeMember, resolveGitHubIdentity, respondToInvitation, revokeInvitation, updateMemberRole, type ResolveGitHubIdentity } from "./workspace-membership.js";
import { readWorkspaceActivity } from "./activity-services.js";

const TX_COOKIE_AGE_MS = 10 * 60 * 1000;
const idSchema = z.uuid();

export function createApp(db: PrismaClient, oauth: OAuthGateway, config: AppConfig, githubGateway?: GitHubGateway,
  resolveInvitationRecipient: ResolveGitHubIdentity = resolveGitHubIdentity): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  const sameOrigin = requireSameOrigin(config.appOrigin);
  const auth = attachUser(db);
  const github = githubGateway ?? (config.githubApp ? createGitHubGateway(config) : undefined);

  app.post("/auth/github-app/start", sameOrigin, auth, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const { workspaceId, repository } = startRepositoryConnectionSchema.parse(request.body);
      await canConnectRepository(db, workspaceId, user.id);
      requireGitHubApp(config);
      const state = randomUrlToken();
      const verifier = randomUrlToken();
      const transaction = { state, verifier, workspaceId, repository, sessionId: response.locals.sessionId as string, issuedAt: Date.now() };
      response.cookie("patchwork_github_connect", Buffer.from(JSON.stringify(transaction)).toString("base64url"), {
        httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/auth/github-app", maxAge: TX_COOKIE_AGE_MS,
      });
      response.json({ data: { authorizationUrl: github!.authorizationUrl(state, verifier) } });
    } catch (error) { next(error); }
  });

  app.get("/auth/github-app/callback", auth, async (request, response, next) => {
    let callbackWorkspaceId: string | null = null;
    try {
      const cookie = request.cookies?.patchwork_github_connect as string | undefined;
      response.clearCookie("patchwork_github_connect", { path: "/auth/github-app" });
      const transaction = (() => {
        try { return JSON.parse(Buffer.from(cookie ?? "", "base64url").toString("utf8")) as
          { state: string; verifier: string; workspaceId: string; repository: string; sessionId: string; issuedAt: number }; }
        catch { return null; }
      })();
      const state = request.query.state;
      const code = request.query.code;
      if (!transaction || typeof state !== "string" ||
        !transaction.state || !transaction.verifier || !equalTokens(transaction.state, state) ||
        !Number.isFinite(transaction.issuedAt) || transaction.issuedAt > Date.now() || Date.now() - transaction.issuedAt > TX_COOKIE_AGE_MS ||
        transaction.sessionId !== response.locals.sessionId) {
        throw new HttpError(400, "INVALID_GITHUB_CALLBACK", "GitHub connection could not be verified");
      }
      const workspaceId = idSchema.parse(transaction.workspaceId);
      callbackWorkspaceId = workspaceId;
      if (typeof code !== "string") throw new HttpError(400, "GITHUB_AUTH_FAILED", "GitHub authorization was not completed");
      const { repository } = connectRepositorySchema.parse({ repository: transaction.repository });
      const user = response.locals.user as { id: string; githubId: string };
      await canConnectRepository(db, workspaceId, user.id);
      requireGitHubApp(config);
      const accessToken = await github!.exchangeCode(code, transaction.verifier);
      const access = await github!.verifyUserRepository(accessToken, user.githubId, repository);
      await connectRepository(db, github!, workspaceId, user.id, repository, access.installationId, access.repositoryId);
      response.redirect(`${config.appOrigin}/workspaces/${workspaceId}/repository`);
    } catch (error) {
      if (callbackWorkspaceId && error instanceof HttpError) {
        response.redirect(`${config.appOrigin}/workspaces/${callbackWorkspaceId}/repository?connectError=${encodeURIComponent(error.code)}`);
      } else next(error);
    }
  });

  app.get("/auth/github/start", (_request, response) => {
    const state = randomUrlToken();
    const verifier = randomUrlToken();
    const options = { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/auth/github", maxAge: TX_COOKIE_AGE_MS };
    response.cookie("patchwork_oauth_state", state, options);
    response.cookie("patchwork_oauth_verifier", verifier, options);
    response.redirect(oauth.authorizationUrl(state, codeChallenge(verifier)));
  });

  app.get("/auth/github/callback", async (request, response, next) => {
    try {
      const stateCookie = request.cookies?.patchwork_oauth_state as string | undefined;
      const verifier = request.cookies?.patchwork_oauth_verifier as string | undefined;
      const state = request.query.state;
      const code = request.query.code;
      response.clearCookie("patchwork_oauth_state", { path: "/auth/github" });
      response.clearCookie("patchwork_oauth_verifier", { path: "/auth/github" });
      if (typeof state !== "string" || typeof code !== "string" || !stateCookie || !verifier || !equalTokens(stateCookie, state)) {
        throw new HttpError(400, "INVALID_OAUTH_CALLBACK", "Sign-in could not be verified");
      }
      const accessToken = await oauth.exchangeCode(code, verifier);
      const profile = await oauth.fetchProfile(accessToken);
      const user = await db.user.upsert({
        where: { githubId: String(profile.id) },
        create: { githubId: String(profile.id), githubLogin: profile.login, name: profile.name, email: profile.email, avatarUrl: profile.avatar_url },
        update: { githubLogin: profile.login, name: profile.name, email: profile.email, avatarUrl: profile.avatar_url },
      });
      await createSession(db, response, user.id, config);
      response.redirect(`${config.appOrigin}/workspaces`);
    } catch (error) { next(error); }
  });

  app.post("/auth/logout", sameOrigin, auth, async (_request, response, next) => {
    try {
      await db.session.update({ where: { id: response.locals.sessionId as string }, data: { revokedAt: new Date() } });
      response.clearCookie(SESSION_COOKIE, { path: "/" });
      response.json({ data: { signedOut: true } });
    } catch (error) { next(error); }
  });

  app.use("/api/v1", auth);
  app.get("/api/v1/me", (_request, response) => {
    const user = response.locals.user as { id: string; githubLogin: string; name: string | null; avatarUrl: string | null };
    response.json({ data: { id: user.id, githubLogin: user.githubLogin, name: user.name, avatarUrl: user.avatarUrl } });
  });

  app.get("/api/v1/workspaces", async (_request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      response.json({ data: await listWorkspaces(db, user.id) });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/workspaces", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const input = createWorkspaceSchema.parse(request.body);
      const workspace = await createWorkspace(db, user.id, input);
      response.status(201).json({ data: { ...workspace, role: "OWNER" } });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/members", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await listWorkspaceMembers(db, workspaceId, user.id) });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/workspaces/:workspaceId/members/:userId", sameOrigin, async (request, response, next) => {
    try {
      const actor = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const userId = idSchema.parse(request.params.userId);
      response.json({ data: await updateMemberRole(db, workspaceId, userId, actor.id, updateMemberRoleSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });
  app.delete("/api/v1/workspaces/:workspaceId/members/:userId", sameOrigin, async (request, response, next) => {
    try {
      const actor = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const userId = idSchema.parse(request.params.userId);
      response.json({ data: await removeMember(db, workspaceId, userId, actor.id) });
    } catch (error) { next(error); }
  });
  app.get("/api/v1/workspaces/:workspaceId/invitations", async (request, response, next) => {
    try {
      const actor = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await listInvitations(db, workspaceId, actor.id) });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/workspaces/:workspaceId/invitations", sameOrigin, async (request, response, next) => {
    try {
      const actor = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const invitation = await createInvitation(db, workspaceId, actor.id,
        createInvitationSchema.parse(request.body), resolveInvitationRecipient);
      response.status(201).json({ data: invitation });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/workspaces/:workspaceId/invitations/:invitationId/revoke", sameOrigin, async (request, response, next) => {
    try {
      const actor = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const invitationId = idSchema.parse(request.params.invitationId);
      response.json({ data: await revokeInvitation(db, workspaceId, invitationId, actor.id) });
    } catch (error) { next(error); }
  });
  app.get("/api/v1/invitations/:token", async (request, response, next) => {
    try {
      const actor = response.locals.user as { githubId: string };
      const token = invitationTokenSchema.parse(request.params.token);
      response.json({ data: await readInvitation(db, token, actor.githubId) });
    } catch (error) { next(error); }
  });
  for (const action of ["accept", "reject"] as const) {
    app.post(`/api/v1/invitations/:token/${action}`, sameOrigin, async (request, response, next) => {
      try {
        const actor = response.locals.user as { id: string; githubId: string };
        const token = invitationTokenSchema.parse(request.params.token);
        response.json({ data: await respondToInvitation(db, token, actor, action === "accept" ? "ACCEPTED" : "REJECTED") });
      } catch (error) { next(error); }
    });
  }

  app.get("/api/v1/workspaces/:workspaceId/health", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await readWorkspaceHealth(db, workspaceId, user.id, Boolean(config.githubApp)) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/activity", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await readWorkspaceActivity(db, workspaceId, user.id, Boolean(config.githubApp),
        config.githubClientSecret, request.query.cursor) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/tasks", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const cursor = request.query.cursor === undefined ? undefined : idSchema.parse(request.query.cursor);
      response.json({ data: await listTasks(db, workspaceId, user.id, cursor) });
    } catch (error) { next(error); }
  });
  app.post("/api/v1/workspaces/:workspaceId/tasks", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const input = createTaskSchema.parse(request.body);
      const task = await createTask(db, workspaceId, user.id, input);
      response.status(201).json({ data: { ...task, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
        revision: taskRevision(task) } });
    } catch (error) { next(error); }
  });

  app.patch("/api/v1/workspaces/:workspaceId/tasks/:taskId", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const taskId = idSchema.parse(request.params.taskId);
      const input = updateTaskSchema.parse(request.body);
      const task = await updateTask(db, workspaceId, taskId, user.id, input);
      response.json({ data: { ...task, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
        revision: taskRevision(task) } });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/github-links", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await listTaskGitHubLinks(db, workspaceId, user.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/workspaces/:workspaceId/tasks/:taskId/github-links", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const taskId = idSchema.parse(request.params.taskId);
      const { itemId } = createTaskGitHubLinkSchema.parse(request.body);
      const link = await linkTaskGitHubItem(db, workspaceId, taskId, itemId, user.id);
      response.status(201).json({ data: link });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/workspaces/:workspaceId/tasks/:taskId/github-links/:linkId/unlink", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const taskId = idSchema.parse(request.params.taskId);
      const linkId = idSchema.parse(request.params.linkId);
      response.json({ data: await unlinkTaskGitHubItem(db, workspaceId, taskId, linkId, user.id) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/repository", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const role = await requireWorkspaceMember(db, workspaceId, user.id);
      response.json({ data: { configured: Boolean(config.githubApp),
        installUrl: config.githubApp ? `https://github.com/apps/${encodeURIComponent(config.githubApp.slug)}/installations/new` : null,
        canManage: role === "OWNER" || role === "ADMIN",
        repository: await readRepository(db, workspaceId, user.id) } });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/repository/items", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const kind = z.enum(["ISSUE", "PULL_REQUEST"]).parse(request.query.kind);
      const cursor = request.query.cursor === undefined ? undefined : idSchema.parse(request.query.cursor);
      response.json({ data: await listRepositoryItems(db, workspaceId, user.id, kind, cursor) });
    } catch (error) { next(error); }
  });

  app.get("/api/v1/workspaces/:workspaceId/repository/activity", async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      const cursor = request.query.cursor === undefined ? undefined : idSchema.parse(request.query.cursor);
      response.json({ data: await listRepositoryActivity(db, workspaceId, user.id, cursor) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/workspaces/:workspaceId/repository/refresh", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      await requireManager(db, workspaceId, user.id);
      requireGitHubApp(config);
      response.json({ data: await refreshRepository(db, github!, workspaceId, user.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/v1/workspaces/:workspaceId/repository/disconnect", sameOrigin, async (request, response, next) => {
    try {
      const user = response.locals.user as { id: string };
      const workspaceId = idSchema.parse(request.params.workspaceId);
      response.json({ data: await disconnectRepository(db, workspaceId, user.id) });
    } catch (error) { next(error); }
  });

  app.use(sendError);
  return app;
}
