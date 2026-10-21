"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiRequest, ApiRequestError, type Workspace } from "@/lib/api";
import { invitationStatusPresentation } from "./invitation-status";

type Role = Workspace["role"];
type Member = { id: string; githubLogin: string; name: string | null; role: Role };
type Invitation = { id: string; recipientLogin: string; role: Role; status: string; expiresAt: string; inviter: { githubLogin: string } };

export default function MembersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const [selfId, setSelfId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [login, setLogin] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER" | "VIEWER">("MEMBER");
  const [invitationLink, setInvitationLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [invitationsLoading, setInvitationsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [invitationsError, setInvitationsError] = useState("");
  const [notice, setNotice] = useState("");
  const canManage = workspace?.role === "OWNER" || workspace?.role === "ADMIN";

  async function reload() {
    const [person, spaces, users] = await Promise.all([
      apiRequest<{ id: string }>("/api/v1/me"),
      apiRequest<Workspace[]>("/api/v1/workspaces"),
      apiRequest<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    ]);
    const selected = spaces.find((space) => space.id === workspaceId) ?? null;
    setSelfId(person.id); setWorkspace(selected); setMembers(users);
    if (selected?.role === "OWNER" || selected?.role === "ADMIN") {
      try { setInvitations(await apiRequest<Invitation[]>(`/api/v1/workspaces/${workspaceId}/invitations`)); setInvitationsError(""); }
      catch (reason) { setInvitationsError(reason instanceof Error ? reason.message : "Could not load invitations"); }
    } else { setInvitations([]); setInvitationsError(""); }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<{ id: string }>("/api/v1/me"),
      apiRequest<Workspace[]>("/api/v1/workspaces"),
      apiRequest<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    ]).then(([person, spaces, users]) => {
      const selected = spaces.find((space) => space.id === workspaceId) ?? null;
      if (!cancelled) { setSelfId(person.id); setWorkspace(selected); setMembers(users); }
      if (selected?.role === "OWNER" || selected?.role === "ADMIN") {
        void apiRequest<Invitation[]>(`/api/v1/workspaces/${workspaceId}/invitations`)
          .then((invites) => { if (!cancelled) setInvitations(invites); })
          .catch((reason: unknown) => { if (!cancelled) setInvitationsError(reason instanceof Error ? reason.message : "Could not load invitations"); })
          .finally(() => { if (!cancelled) setInvitationsLoading(false); });
      } else if (!cancelled) setInvitationsLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Could not load workspace members");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, router]);

  async function run(action: () => Promise<void>, success: string, refresh = true) {
    setSaving(true); setError(""); setNotice("");
    try { await action(); if (refresh) await reload(); setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update membership"); }
    finally { setSaving(false); }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const result = await apiRequest<{ token: string }>(`/api/v1/workspaces/${workspaceId}/invitations`, {
        method: "POST", body: JSON.stringify({ githubLogin: login, role: inviteRole }),
      });
      setInvitationLink(`${window.location.origin}/invitations/${result.token}`);
      setLogin("");
    }, "Invitation created. Share the link privately with the intended GitHub user. It is shown only now.");
  }

  function canChange(member: Member) {
    return workspace?.role === "OWNER" ||
      (workspace?.role === "ADMIN" && member.id !== selfId && (member.role === "MEMBER" || member.role === "VIEWER"));
  }

  function canRemove(member: Member) {
    if (member.id === selfId) return workspace?.role !== "VIEWER";
    return canChange(member);
  }

  return <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
    <Link href={`/workspaces/${workspaceId}`} className="text-sm font-semibold text-indigo-700 hover:underline">← Workspace</Link>
    <header className="my-8"><h1 className="text-3xl font-bold text-slate-900">Members and invitations</h1>
      <p className="mt-2 text-slate-600">{workspace?.name ?? "Workspace"}</p></header>
    {loading && <p role="status">Loading members…</p>}
    {error && <p role="alert" className="mb-5 rounded-xl bg-rose-50 p-4 text-rose-700">{error}</p>}
    {notice && <p role="status" className="mb-5 rounded-xl bg-emerald-50 p-4 text-emerald-800">{notice}</p>}
    {!loading && workspace && <>
      <section aria-labelledby="members-heading" className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 id="members-heading" className="text-xl font-semibold">Members</h2>
        <ul className="mt-4 space-y-4">{members.map((member) => <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div><p className="font-semibold">{member.name ?? member.githubLogin} {member.id === selfId ? "(you)" : ""}</p><p className="text-sm text-slate-600">@{member.githubLogin} · {member.role.toLowerCase()}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            {canChange(member) && <label className="text-sm">Role <select aria-label={`Role for ${member.githubLogin}`} value={member.role} disabled={saving}
              onChange={(event) => { const role = event.target.value as Role; void run(async () => {
                await apiRequest(`/api/v1/workspaces/${workspaceId}/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ role }) });
              }, `Updated @${member.githubLogin}.`); }} className="ml-2 rounded-lg border border-slate-300 px-2 py-2">
              {(workspace?.role === "OWNER" ? ["OWNER", "ADMIN", "MEMBER", "VIEWER"] : ["MEMBER", "VIEWER"]).map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}
            </select></label>}
            {canRemove(member) && <button type="button" disabled={saving} onClick={() => {
              if (!window.confirm(`Remove @${member.githubLogin} from this workspace?`)) return;
              void run(async () => { await apiRequest(`/api/v1/workspaces/${workspaceId}/members/${member.id}`, { method: "DELETE" });
                if (member.id === selfId) router.replace("/workspaces"); }, `Removed @${member.githubLogin}.`, member.id !== selfId);
            }} className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-60">{member.id === selfId ? "Leave" : "Remove"}</button>}
          </div>
        </li>)}</ul>
        <p className="mt-5 text-sm text-slate-500">Members with assigned tasks must have those tasks reassigned before removal. The last owner cannot leave or be demoted.</p>
      </section>
      {canManage && <section aria-labelledby="invitations-heading" className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 id="invitations-heading" className="text-xl font-semibold">Invitations</h2>
        {invitationsLoading && <p role="status" className="mt-3 text-sm text-slate-600">Loading invitations…</p>}
        {invitationsError && <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Invitations: {invitationsError}. Members remain available.</p>}
        <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block text-sm font-medium">GitHub username<input value={login} onChange={(event) => setLogin(event.target.value)} required maxLength={39}
            className="mt-2 block rounded-lg border border-slate-300 px-3 py-2" placeholder="teammate" /></label>
          <label className="block text-sm font-medium">Role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}
            className="mt-2 block rounded-lg border border-slate-300 px-3 py-2">
            {workspace.role === "OWNER" && <option value="ADMIN">admin</option>}
            <option value="MEMBER">member</option><option value="VIEWER">viewer</option>
          </select></label>
          <button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{saving ? "Saving…" : "Create invitation"}</button>
        </form>
        <p className="mt-3 text-sm text-slate-600">The recipient must sign in with the invited GitHub account before opening the link. Links expire after seven days.</p>
        {invitationLink && <label className="mt-4 block text-sm font-medium">Private invitation link<input readOnly value={invitationLink} onFocus={(event) => event.target.select()}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>}
        <ul className="mt-6 space-y-3">{invitations.map((invitation) => {
          const presentation = invitationStatusPresentation(invitation.status);
          return <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="break-words font-semibold text-slate-900">@{invitation.recipientLogin}</span><span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${presentation.className}`}>{presentation.label}</span></div>
              <p className="mt-1 text-slate-600">{invitation.role.toLowerCase()} · expires <time dateTime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleDateString()}</time> · invited by @{invitation.inviter.githubLogin}</p></div>
            {invitation.status === "PENDING" && (workspace.role === "OWNER" || invitation.role !== "ADMIN") && <button type="button" disabled={saving}
              onClick={() => void run(async () => { await apiRequest(`/api/v1/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`, { method: "POST" }); }, "Invitation revoked.")}
              className="font-semibold text-rose-700 underline disabled:opacity-60">Revoke</button>}
          </li>;
        })}</ul>
        {!invitationsLoading && !invitationsError && invitations.length === 0 && <p className="mt-5 text-sm text-slate-600">No invitations yet.</p>}
      </section>}
    </>}
  </div>;
}
