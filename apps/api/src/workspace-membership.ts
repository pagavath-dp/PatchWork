import type { PrismaClient } from "@patchwork/db";
import type { CreateInvitationInput, UpdateMemberRoleInput, WorkspaceRole } from "@patchwork/contracts";
import { HttpError } from "./http.js";
import { randomUrlToken, sha256 } from "./oauth.js";
import { lockWorkspace, requireWorkspaceMember } from "./services.js";

const INVITATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type GitHubIdentity = { githubId: string; login: string };
export type ResolveGitHubIdentity = (login: string) => Promise<GitHubIdentity>;

export async function resolveGitHubIdentity(login: string): Promise<GitHubIdentity> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "PatchWork" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new HttpError(503, "GITHUB_LOOKUP_UNAVAILABLE", "Could not verify that GitHub account. Try again later.");
  }
  if (response.status === 404) throw new HttpError(404, "RECIPIENT_NOT_FOUND", "GitHub account not found");
  if (!response.ok) throw new HttpError(503, "GITHUB_LOOKUP_UNAVAILABLE", "Could not verify that GitHub account. Try again later.");
  const profile: unknown = await response.json().catch(() => null);
  if (!profile || typeof profile !== "object" || !("id" in profile) || !("login" in profile) ||
    typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id <= 0 ||
    typeof profile.login !== "string" || profile.login.toLowerCase() !== login.toLowerCase()) {
    throw new HttpError(503, "GITHUB_LOOKUP_UNAVAILABLE", "Could not verify that GitHub account. Try again later.");
  }
  return { githubId: String(profile.id), login: profile.login };
}

function requireManager(role: WorkspaceRole): void {
  if (role !== "OWNER" && role !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "Only owners and admins can manage invitations or members");
}

function canGrant(role: WorkspaceRole, target: WorkspaceRole): boolean {
  return role === "OWNER" || (role === "ADMIN" && (target === "MEMBER" || target === "VIEWER"));
}

function invitationState(invitation: { status: string; expiresAt: Date }): string {
  return invitation.status === "PENDING" && invitation.expiresAt <= new Date() ? "EXPIRED" : invitation.status;
}

export async function createInvitation(db: PrismaClient, workspaceId: string, inviterId: string,
  input: CreateInvitationInput, resolveIdentity: ResolveGitHubIdentity = resolveGitHubIdentity) {
  const initialRole = await requireWorkspaceMember(db, workspaceId, inviterId);
  requireManager(initialRole);
  if (!canGrant(initialRole, input.role)) throw new HttpError(403, "FORBIDDEN", "You cannot invite an admin");
  const recipient = await resolveIdentity(input.githubLogin);
  const token = randomUrlToken();
  const invitation = await db.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const role = await requireWorkspaceMember(tx, workspaceId, inviterId);
    requireManager(role);
    if (!canGrant(role, input.role)) throw new HttpError(403, "FORBIDDEN", "You cannot invite an admin");
    const user = await tx.user.findUnique({ where: { githubId: recipient.githubId }, select: { id: true } });
    if (user && await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.id } } })) {
      throw new HttpError(409, "ALREADY_MEMBER", "That GitHub account is already a workspace member");
    }
    const pending = await tx.workspaceInvitation.findFirst({ where: {
      workspaceId, recipientGithubId: recipient.githubId, status: "PENDING", expiresAt: { gt: new Date() },
    } });
    if (pending) throw new HttpError(409, "INVITATION_EXISTS", "An active invitation already exists for that GitHub account");
    return tx.workspaceInvitation.create({ data: {
      workspaceId, inviterId, recipientGithubId: recipient.githubId, recipientLogin: recipient.login,
      role: input.role, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITATION_AGE_MS),
    } });
  });
  return { id: invitation.id, workspaceId, recipientLogin: invitation.recipientLogin, role: invitation.role,
    status: invitation.status, expiresAt: invitation.expiresAt, token };
}

export async function listInvitations(db: PrismaClient, workspaceId: string, actorId: string) {
  requireManager(await requireWorkspaceMember(db, workspaceId, actorId));
  const invitations = await db.workspaceInvitation.findMany({ where: { workspaceId },
    select: { id: true, recipientLogin: true, role: true, status: true, createdAt: true, expiresAt: true,
      respondedAt: true, inviter: { select: { githubLogin: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  return invitations.map((invitation) => ({ ...invitation, status: invitationState(invitation) }));
}

export async function readInvitation(db: PrismaClient, token: string, githubId: string) {
  const invitation = await db.workspaceInvitation.findUnique({ where: { tokenHash: sha256(token) },
    include: { workspace: { select: { id: true, name: true } }, inviter: { select: { githubLogin: true } } } });
  if (!invitation || invitation.recipientGithubId !== githubId) throw new HttpError(404, "NOT_FOUND", "Invitation not found");
  return { id: invitation.id, workspace: invitation.workspace, inviter: invitation.inviter.githubLogin,
    role: invitation.role, status: invitationState(invitation), expiresAt: invitation.expiresAt };
}

export async function respondToInvitation(db: PrismaClient, token: string, user: { id: string; githubId: string },
  action: "ACCEPTED" | "REJECTED") {
  return db.$transaction(async (tx) => {
    const existing = await tx.workspaceInvitation.findUnique({ where: { tokenHash: sha256(token) }, select: { workspaceId: true } });
    if (!existing) throw new HttpError(404, "NOT_FOUND", "Invitation not found");
    await lockWorkspace(tx, existing.workspaceId);
    const invitation = await tx.workspaceInvitation.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    if (invitation.recipientGithubId !== user.githubId) throw new HttpError(404, "NOT_FOUND", "Invitation not found");
    if (invitation.status !== "PENDING") throw new HttpError(409, "INVITATION_USED", "Invitation is no longer active");
    if (invitation.expiresAt <= new Date()) throw new HttpError(410, "INVITATION_EXPIRED", "Invitation has expired");
    if (action === "ACCEPTED" && await tx.workspaceMember.findUnique({ where: {
      workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id },
    } })) throw new HttpError(409, "ALREADY_MEMBER", "You are already a workspace member");
    const changed = await tx.workspaceInvitation.updateMany({ where: {
      id: invitation.id, status: "PENDING", expiresAt: { gt: new Date() },
    }, data: { status: action, respondedAt: new Date(), ...(action === "ACCEPTED" ? { acceptedById: user.id } : {}) } });
    if (changed.count !== 1) throw new HttpError(409, "INVITATION_USED", "Invitation is no longer active");
    if (action === "ACCEPTED") await tx.workspaceMember.create({ data: {
      workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role,
    } });
    return { workspaceId: invitation.workspaceId, status: action };
  });
}

export async function revokeInvitation(db: PrismaClient, workspaceId: string, invitationId: string, actorId: string) {
  return db.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const role = await requireWorkspaceMember(tx, workspaceId, actorId);
    requireManager(role);
    const invitation = await tx.workspaceInvitation.findFirst({ where: { id: invitationId, workspaceId } });
    if (!invitation) throw new HttpError(404, "NOT_FOUND", "Invitation not found");
    if (!canGrant(role, invitation.role)) throw new HttpError(403, "FORBIDDEN", "You cannot revoke this invitation");
    if (invitation.status !== "PENDING" || invitation.expiresAt <= new Date()) {
      throw new HttpError(409, "INVITATION_USED", "Invitation is no longer active");
    }
    await tx.workspaceInvitation.update({ where: { id: invitationId }, data: { status: "REVOKED", respondedAt: new Date() } });
    return { revoked: true };
  });
}

export async function updateMemberRole(db: PrismaClient, workspaceId: string, targetId: string, actorId: string,
  input: UpdateMemberRoleInput) {
  return db.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const actorRole = await requireWorkspaceMember(tx, workspaceId, actorId);
    requireManager(actorRole);
    const target = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetId } } });
    if (!target) throw new HttpError(404, "NOT_FOUND", "Member not found");
    if (actorRole === "ADMIN" && (targetId === actorId || target.role === "ADMIN" || target.role === "OWNER" ||
      !canGrant(actorRole, input.role))) throw new HttpError(403, "FORBIDDEN", "Admins cannot change this role");
    if (target.role === "OWNER" && input.role !== "OWNER") await protectAndTransferOwner(tx, workspaceId, targetId);
    if (input.role !== "OWNER" && (target.role === "OWNER" || target.role === "ADMIN")) {
      await tx.workspaceInvitation.updateMany({ where: { workspaceId, inviterId: targetId, status: "PENDING",
        ...(input.role === "ADMIN" ? { role: "ADMIN" } : {}) },
      data: { status: "REVOKED", respondedAt: new Date() } });
    }
    const updated = await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: targetId } },
      data: { role: input.role } });
    return { userId: updated.userId, role: updated.role };
  });
}

async function protectAndTransferOwner(tx: Pick<PrismaClient, "workspace" | "workspaceMember">, workspaceId: string, departingId: string): Promise<void> {
  const replacement = await tx.workspaceMember.findFirst({ where: { workspaceId, role: "OWNER", userId: { not: departingId } },
    orderBy: { joinedAt: "asc" }, select: { userId: true } });
  if (!replacement) throw new HttpError(409, "LAST_OWNER", "Assign another owner before changing the last owner");
  await tx.workspace.updateMany({ where: { id: workspaceId, ownerId: departingId }, data: { ownerId: replacement.userId } });
}

export async function removeMember(db: PrismaClient, workspaceId: string, targetId: string, actorId: string) {
  return db.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const actorRole = await requireWorkspaceMember(tx, workspaceId, actorId);
    if (actorRole === "VIEWER") throw new HttpError(403, "FORBIDDEN", "Viewers cannot leave or remove members");
    const target = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetId } } });
    if (!target) throw new HttpError(404, "NOT_FOUND", "Member not found");
    if (actorId !== targetId) {
      requireManager(actorRole);
      if (actorRole === "ADMIN" && (target.role === "OWNER" || target.role === "ADMIN")) {
        throw new HttpError(403, "FORBIDDEN", "Admins cannot remove owners or admins");
      }
    }
    if (target.role === "OWNER") await protectAndTransferOwner(tx, workspaceId, targetId);
    const assignments = await tx.task.count({ where: { workspaceId, assigneeId: targetId } });
    if (assignments > 0) throw new HttpError(409, "MEMBER_HAS_TASKS", "Reassign this member's tasks before removing them");
    await tx.workspaceInvitation.updateMany({ where: { workspaceId, inviterId: targetId, status: "PENDING" },
      data: { status: "REVOKED", respondedAt: new Date() } });
    await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: targetId } } });
    return { removed: true };
  });
}
