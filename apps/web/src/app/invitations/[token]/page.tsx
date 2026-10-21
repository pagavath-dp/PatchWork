"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiRequest, ApiRequestError } from "@/lib/api";

type Invitation = { workspace: { id: string; name: string }; inviter: string; role: string; status: string; expiresAt: string };

export default function InvitationPage() {
  const { token } = useParams<{ token: string }>();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest<Invitation>(`/api/v1/invitations/${encodeURIComponent(token)}`)
      .then((value) => { if (!cancelled) setInvitation(value); })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof ApiRequestError && reason.status === 401) setNeedsLogin(true);
        else setError(reason instanceof Error ? reason.message : "Could not load invitation");
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  async function respond(action: "accept" | "reject") {
    setSaving(true); setError("");
    try {
      const result = await apiRequest<{ workspaceId: string; status: string }>(`/api/v1/invitations/${encodeURIComponent(token)}/${action}`, { method: "POST" });
      setInvitation((current) => current ? { ...current, status: result.status } : current);
      setNotice(action === "accept" ? "Invitation accepted. Your workspace is ready." : "Invitation declined.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not respond to invitation"); }
    finally { setSaving(false); }
  }

  return <div className="mx-auto max-w-xl px-5 py-12 sm:px-8">
    <Link href="/workspaces" className="text-sm font-semibold text-indigo-700 hover:underline">← Workspaces</Link>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-3xl font-bold text-slate-900">Workspace invitation</h1>
      {loading && <p role="status" className="mt-5 text-slate-600">Loading invitation…</p>}
      {needsLogin && <div className="mt-5"><p className="text-slate-700">Sign in with the invited GitHub account, then reopen this private invitation link.</p>
        <Link href="/login" className="mt-3 inline-block font-semibold text-indigo-700 underline">Sign in</Link></div>}
      {error && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-4 text-rose-700">{error} If you were invited, check that you signed in with the intended GitHub account.</p>}
      {notice && <p role="status" className="mt-5 rounded-xl bg-emerald-50 p-4 text-emerald-800">{notice}</p>}
      {invitation && <div className="mt-5 space-y-3 text-slate-700">
        <p><strong>{invitation.workspace.name}</strong> · invited by @{invitation.inviter}</p>
        <p>Role: {invitation.role.toLowerCase()} · Status: {invitation.status.toLowerCase()}</p>
        <p className="text-sm">Expires {new Date(invitation.expiresAt).toLocaleString()}</p>
        {invitation.status === "PENDING" && <div className="flex gap-3 pt-2">
          <button type="button" disabled={saving} onClick={() => void respond("accept")}
            className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{saving ? "Saving…" : "Accept invitation"}</button>
          <button type="button" disabled={saving} onClick={() => void respond("reject")}
            className="rounded-lg border border-slate-300 px-4 py-2 font-semibold disabled:opacity-60">Decline</button>
        </div>}
        {invitation.status === "ACCEPTED" && <Link href={`/workspaces/${invitation.workspace.id}`}
          className="inline-block font-semibold text-indigo-700 underline">Open workspace →</Link>}
      </div>}
    </section>
  </div>;
}
