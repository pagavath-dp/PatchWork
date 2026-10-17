"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiRequest, ApiRequestError } from "@/lib/api";
import { connectionErrorMessage, repositoryAvailability } from "@/lib/repository-availability";

type Item = { id: string; number: number; title: string; state: string; htmlUrl: string; authorLogin: string | null; updatedAt: string };
type Activity = { id: string; event: string; itemNumber: number; itemTitle: string; itemUrl: string; actorLogin: string | null; occurredAt: string };
type RepositoryData = {
  connection: { fullName: string; htmlUrl: string; description: string | null; defaultBranch: string; isPrivate: boolean; lastSyncedAt: string | null; lastSyncError: string | null; disconnectedAt: string | null };
  issues: Item[]; pulls: Item[]; activities: Activity[];
  issuesNextCursor: string | null; pullsNextCursor: string | null; activitiesNextCursor: string | null;
};
type Payload = { configured: boolean; installUrl: string | null; canManage: boolean; repository: RepositoryData | null };

function githubUrl(value: string): string {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "#"; }
  catch { return "#"; }
}

function ItemList({ title, items, canLoadMore, loadingMore, onLoadMore }: { title: string; items: Item[]; canLoadMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
    {items.length === 0 ? <p className="mt-4 text-sm text-slate-500">No recent {title.toLowerCase()}.</p> :
      <ul className="mt-4 space-y-3">{items.map((item) => <li key={item.id} className="rounded-xl border border-slate-100 p-3">
        <a href={githubUrl(item.htmlUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline">#{item.number} {item.title}</a>
        <p className="mt-1 text-xs text-slate-500">{item.state} · {item.authorLogin ?? "Unknown author"} · Updated {new Date(item.updatedAt).toLocaleDateString()}</p>
      </li>)}</ul>}
    {canLoadMore && <button type="button" onClick={onLoadMore} disabled={loadingMore} className="mt-4 rounded-lg border border-indigo-200 px-3 py-2 text-sm font-semibold text-indigo-700 disabled:opacity-60">{loadingMore ? "Loading…" : "Load older records"}</button>}
  </section>;
}

export default function RepositoryPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [repository, setRepository] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"issues" | "pulls" | "activities" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("connectError");
    if (!code) return;
    setError(connectionErrorMessage(code));
  }, []);
  const load = useCallback(async () => {
    try {
      const payload = await apiRequest<Payload>(`/api/v1/workspaces/${workspaceId}/repository`);
      setData(payload);
      if (payload.repository?.connection.disconnectedAt) setRepository(payload.repository.connection.fullName);
    }
    catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Could not load repository");
    } finally { setLoading(false); }
  }, [router, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.trim())) {
      setError("Enter a repository as owner/name"); return;
    }
    try {
      const result = await apiRequest<{ authorizationUrl: string }>("/auth/github-app/start", {
        method: "POST", body: JSON.stringify({ workspaceId, repository: repository.trim() }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start GitHub authorization"); }
  }

  async function refresh() {
    setRefreshing(true); setError("");
    try {
      await apiRequest<RepositoryData>(`/api/v1/workspaces/${workspaceId}/repository/refresh`, { method: "POST" });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh repository"); }
    finally { setRefreshing(false); }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this repository? Saved activity and task links will be retained.")) return;
    setDisconnecting(true); setError("");
    try {
      await apiRequest(`/api/v1/workspaces/${workspaceId}/repository/disconnect`, { method: "POST" });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not disconnect repository"); }
    finally { setDisconnecting(false); }
  }

  async function loadMore(kind: "issues" | "pulls" | "activities") {
    const cursor = data?.repository?.[`${kind}NextCursor`];
    if (!cursor || loadingMore) return;
    setLoadingMore(kind); setError("");
    const path = kind === "activities" ? "activity" : `items?kind=${kind === "issues" ? "ISSUE" : "PULL_REQUEST"}&`;
    const separator = kind === "activities" ? "?" : "";
    try {
      const result = await apiRequest<{ items: Item[] & Activity[]; nextCursor: string | null }>(
        `/api/v1/workspaces/${workspaceId}/repository/${path}${separator}cursor=${encodeURIComponent(cursor)}`);
      setData((current) => {
        if (!current?.repository) return current;
        const repo = current.repository;
        if (kind === "activities") return { ...current, repository: { ...repo,
          activities: [...repo.activities, ...(result.items as Activity[])], activitiesNextCursor: result.nextCursor } };
        return { ...current, repository: { ...repo, [kind]: [...repo[kind], ...(result.items as Item[])],
          [`${kind}NextCursor`]: result.nextCursor } };
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load older records"); }
    finally { setLoadingMore(null); }
  }

  const repo = data?.repository;
  const availability = data ? repositoryAvailability(data.configured, Boolean(repo), Boolean(repo?.connection.disconnectedAt)) : null;
  return <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
    <Link href={`/workspaces/${workspaceId}`} className="text-sm font-semibold text-indigo-700 hover:underline">← Back to workspace</Link>
    <header className="mt-6 mb-8"><p className="text-sm font-bold uppercase tracking-[0.2em] text-indigo-600">GitHub integration</p><h1 className="mt-2 text-3xl font-bold text-slate-900">Repository activity</h1><p className="mt-2 text-slate-600">Read-only snapshots update when an owner or admin refreshes them.</p></header>
    {error && <p role="alert" className="mb-6 rounded-xl bg-rose-50 p-4 text-rose-700">{error}</p>}
    {loading ? <p role="status" className="rounded-2xl bg-white p-8 text-slate-600">Loading repository…</p> : !data ? <button onClick={() => { setLoading(true); void load(); }} className="font-semibold text-indigo-700">Try again</button> : availability === "setup" ?
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900">GitHub App setup is needed before a repository can be connected. Ask the project maintainer to configure the server.</div> : !repo ?
      <section className="max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Connect a repository</h2>
        <p className="mt-2 text-sm text-slate-600">Install the PatchWork GitHub App on the repository first. Then authorize using the GitHub account you use to sign in here.</p>
        {data.installUrl && <a href={data.installUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block text-sm font-semibold text-indigo-700 hover:underline">Install GitHub App ↗</a>}
        {data.canManage ? <form onSubmit={connect} className="mt-5 space-y-3">
          <label htmlFor="repository-name" className="block text-sm font-medium text-slate-700">Repository (owner/name)</label>
          <input id="repository-name" value={repository} onChange={(event) => setRepository(event.target.value)} required placeholder="owner/repository" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <button className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-500">Connect with GitHub</button>
        </form> : <p className="mt-5 text-sm text-slate-600">An owner or admin can connect this workspace.</p>}
      </section> : <>
      {availability === "cached" && <p role="status" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Showing saved repository data. {data.configured ? "The repository is disconnected; live refresh is unavailable until it is reconnected." : "GitHub App configuration is missing; live refresh and reconnection are unavailable."}</p>}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold text-slate-900"><a href={githubUrl(repo.connection.htmlUrl)} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">{repo.connection.fullName} ↗</a></h2>
          <p className="mt-2 text-slate-600">{repo.connection.description ?? "No repository description"}</p>
          <p className="mt-3 text-sm text-slate-500">{repo.connection.isPrivate ? "Private" : "Public"} · Default branch: {repo.connection.defaultBranch}</p>
          <p className="mt-1 text-sm text-slate-500">Saved snapshot last refreshed: {repo.connection.lastSyncedAt ? new Date(repo.connection.lastSyncedAt).toLocaleString() : "Never"}</p></div>
          {data.canManage && !repo.connection.disconnectedAt && <div className="flex flex-wrap gap-2">{availability === "live" && <button onClick={refresh} disabled={refreshing} className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{refreshing ? "Refreshing…" : "Refresh now"}</button>}<button onClick={disconnect} disabled={disconnecting} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 disabled:opacity-60">{disconnecting ? "Disconnecting…" : "Disconnect"}</button></div>}
        </div>
        {repo.connection.disconnectedAt && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>This repository is disconnected. Saved activity is retained, but refresh and new task links are paused.</p>{data.canManage && data.configured && <form onSubmit={connect} className="mt-3 flex flex-wrap gap-2"><label htmlFor="reconnect-repository" className="sr-only">Repository (owner/name)</label><input id="reconnect-repository" value={repository} onChange={(event) => setRepository(event.target.value)} required className="min-w-0 flex-1 rounded-lg border border-amber-300 px-3 py-2" /><button className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white">Reconnect with GitHub</button></form>}</div>}
        {repo.connection.lastSyncError && <p role="alert" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Latest refresh failed: {repo.connection.lastSyncError}. Showing the last saved snapshot.</p>}
      </section>
      <div className="mt-6 grid gap-6 lg:grid-cols-2"><ItemList title="Pull requests" items={repo.pulls} canLoadMore={Boolean(repo.pullsNextCursor)} loadingMore={loadingMore === "pulls"} onLoadMore={() => void loadMore("pulls")} /><ItemList title="Issues" items={repo.issues} canLoadMore={Boolean(repo.issuesNextCursor)} loadingMore={loadingMore === "issues"} onLoadMore={() => void loadMore("issues")} /></div>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold text-slate-900">Activity timeline</h2>
        {repo.activities.length === 0 ? <p className="mt-4 text-sm text-slate-500">No recent issue or pull request events were returned by GitHub.</p> :
          <ol className="mt-4 space-y-4 border-l-2 border-indigo-100 pl-5">{repo.activities.map((activity) => <li key={activity.id} className="relative"><span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full bg-indigo-500" />
            <p className="text-sm text-slate-700"><span className="font-semibold">{activity.actorLogin ?? "Someone"}</span> {activity.event.replaceAll("_", " ")} on <a href={githubUrl(activity.itemUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline">#{activity.itemNumber} {activity.itemTitle}</a></p>
            <time className="text-xs text-slate-500">{new Date(activity.occurredAt).toLocaleString()}</time></li>)}</ol>}
        {repo.activitiesNextCursor && <button type="button" onClick={() => void loadMore("activities")} disabled={loadingMore === "activities"} className="mt-4 rounded-lg border border-indigo-200 px-3 py-2 text-sm font-semibold text-indigo-700 disabled:opacity-60">{loadingMore === "activities" ? "Loading…" : "Load older activity"}</button>}
      </section>
    </>}
  </main>;
}
