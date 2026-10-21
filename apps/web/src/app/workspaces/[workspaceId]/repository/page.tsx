"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, CircleAlert, Clock3, GitBranch, GitPullRequest, CircleDot, RotateCw, Unplug } from "lucide-react";
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
  return <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2.5">{title === "Pull requests" ? <GitPullRequest aria-hidden="true" size={19} className="text-indigo-600" /> : <CircleDot aria-hidden="true" size={19} className="text-indigo-600" />}<h2 className="text-lg font-semibold text-slate-900">{title}</h2></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600" aria-label={`${items.length} loaded records`}>{items.length} loaded</span></div>
    {items.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">No recent {title.toLowerCase()} in the saved snapshot.</p> :
      <ul className="mt-5 divide-y divide-slate-100 border-t border-slate-100">{items.map((item) => <li key={item.id} className="py-4 first:pt-4 last:pb-0">
        <div className="flex flex-wrap items-start justify-between gap-2"><a href={githubUrl(item.htmlUrl)} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words text-sm font-semibold leading-relaxed text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">#{item.number} {item.title} <ArrowUpRight aria-hidden="true" size={13} className="inline" /></a><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize text-slate-600">{item.state}</span></div>
        <p className="mt-2 text-xs text-slate-500">{item.authorLogin ? `@${item.authorLogin}` : "Unknown author"} · Updated {new Date(item.updatedAt).toLocaleDateString()}</p>
      </li>)}</ul>}
    {canLoadMore && <button type="button" onClick={onLoadMore} disabled={loadingMore} className="mt-5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">{loadingMore ? "Loading…" : "Load older records"}</button>}
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
  const savedAt = repo?.connection.lastSyncedAt ? Date.parse(repo.connection.lastSyncedAt) : NaN;
  const snapshotAge = !Number.isFinite(savedAt) ? "not yet refreshed" :
    Date.now() - savedAt > 24 * 60 * 60 * 1000 ? "over 24 hours old" : "within 24 hours";
  return <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8 lg:px-10">
    <Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><ArrowLeft aria-hidden="true" size={16} />Workspace dashboard</Link>
    <header className="mb-7 mt-7 border-b border-slate-200 pb-7"><p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">GitHub integration</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Repository activity</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">Read saved issues, pull requests, and repository events. Owners and admins can refresh the snapshot manually.</p></header>
    {error && <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><CircleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0" /><p>{error}</p></div>}
    {loading ? <div role="status" className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><p className="font-semibold text-slate-800">Loading repository…</p><p className="mt-1 text-sm text-slate-500">Checking the latest saved connection and snapshot.</p><div aria-hidden="true" className="mt-5 h-24 animate-pulse rounded-xl bg-slate-100" /></div> : !data ? <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm"><h2 className="font-semibold text-slate-900">Repository details are unavailable</h2><p className="mt-1 text-sm text-slate-600">Try loading the saved repository again.</p><button type="button" onClick={() => { setLoading(true); void load(); }} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500"><RotateCw aria-hidden="true" size={16} />Try again</button></div> : availability === "setup" ?
      <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900"><CircleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" /><div><h2 className="font-semibold">GitHub App setup needed</h2><p className="mt-1 text-sm">GitHub App setup is needed before a repository can be connected. Ask the project maintainer to configure the server.</p></div></div> : !repo ?
      <section className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <span className="inline-flex rounded-xl bg-indigo-50 p-2.5 text-indigo-700"><GitBranch aria-hidden="true" size={22} /></span>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">Connect a repository</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">Install the PatchWork GitHub App on the repository first. Then authorize using the GitHub account you use to sign in here.</p>
        {data.installUrl && <a href={data.installUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">Install GitHub App <ArrowUpRight aria-hidden="true" size={15} /></a>}
        {data.canManage ? <form onSubmit={connect} className="mt-6 space-y-3 border-t border-slate-100 pt-5">
          <label htmlFor="repository-name" className="block text-sm font-semibold text-slate-700">Repository (owner/name)</label>
          <input id="repository-name" value={repository} onChange={(event) => setRepository(event.target.value)} required placeholder="owner/repository" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-indigo-500" />
          <button className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500">Connect with GitHub</button>
        </form> : <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">An owner or admin can connect this workspace.</p>}
      </section> : <>
      {availability === "cached" && <div role="status" className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><CircleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0" /><p><span className="font-semibold">Showing saved repository data.</span> {data.configured ? "The repository is disconnected; live refresh is unavailable until it is reconnected." : "GitHub App configuration is missing; live refresh and reconnection are unavailable."}</p></div>}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5"><div className="min-w-0 flex-1"><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">{repo.connection.disconnectedAt ? "Saved repository" : "Connected repository"}</p><h2 className="mt-2 break-words text-2xl font-bold tracking-tight text-slate-900"><a href={githubUrl(repo.connection.htmlUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-baseline gap-1 text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">{repo.connection.fullName} <ArrowUpRight aria-hidden="true" size={17} className="shrink-0" /></a></h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">{repo.connection.description ?? "No repository description"}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">{repo.connection.isPrivate ? "Private" : "Public"}</span><span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">Default branch: {repo.connection.defaultBranch}</span><span className={`rounded-full px-3 py-1.5 ${availability === "live" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{availability === "live" ? "Live refresh available" : "Saved snapshot only"}</span></div></div>
          {data.canManage && !repo.connection.disconnectedAt && <div className="flex flex-wrap gap-2">{availability === "live" && <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60"><RotateCw aria-hidden="true" size={16} />{refreshing ? "Refreshing…" : "Refresh now"}</button>}<button type="button" onClick={disconnect} disabled={disconnecting} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60"><Unplug aria-hidden="true" size={16} />{disconnecting ? "Disconnecting…" : "Disconnect"}</button></div>}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-4 text-sm text-slate-600"><Clock3 aria-hidden="true" size={16} className="shrink-0 text-indigo-600" /><p>Saved snapshot last refreshed: <span className="font-semibold text-slate-800">{repo.connection.lastSyncedAt ? new Date(repo.connection.lastSyncedAt).toLocaleString() : "Never"}</span></p><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">{snapshotAge}</span></div>
        {repo.connection.disconnectedAt && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Repository disconnected</p><p className="mt-1">Saved activity is retained, but refresh and new task links are paused.</p>{data.canManage && data.configured && <form onSubmit={connect} className="mt-4 flex flex-col gap-2 sm:flex-row"><label htmlFor="reconnect-repository" className="sr-only">Repository (owner/name)</label><input id="reconnect-repository" value={repository} onChange={(event) => setRepository(event.target.value)} required className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-indigo-500" /><button className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500">Reconnect with GitHub</button></form>}</div>}
        {repo.connection.lastSyncError && <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><CircleAlert aria-hidden="true" size={17} className="mt-0.5 shrink-0" /><p>Latest refresh failed: {repo.connection.lastSyncError}. Showing the last saved snapshot.</p></div>}
      </section>
      <div className="mt-6 grid gap-6 lg:grid-cols-2"><ItemList title="Pull requests" items={repo.pulls} canLoadMore={Boolean(repo.pullsNextCursor)} loadingMore={loadingMore === "pulls"} onLoadMore={() => void loadMore("pulls")} /><ItemList title="Issues" items={repo.issues} canLoadMore={Boolean(repo.issuesNextCursor)} loadingMore={loadingMore === "issues"} onLoadMore={() => void loadMore("issues")} /></div>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">Saved GitHub events</p><h2 className="mt-1 text-lg font-semibold text-slate-900">Repository activity timeline</h2></div><p className="text-xs text-slate-500">Issue and pull request events only</p></div>
        {repo.activities.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">No recent issue or pull request events were returned by GitHub.</p> :
          <ol className="mt-6 space-y-0 border-l border-slate-200 pl-5 sm:pl-7">{repo.activities.map((activity) => <li key={activity.id} className="relative pb-5 last:pb-0"><span aria-hidden="true" className="absolute -left-[29px] top-1 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 ring-4 ring-white sm:-left-[37px]"><GitBranch size={12} /></span>
            <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold capitalize text-indigo-700">{activity.event.replaceAll("_", " ")}</span><time dateTime={activity.occurredAt} className="inline-flex items-center gap-1.5 text-xs text-slate-500"><Clock3 aria-hidden="true" size={13} />{new Date(activity.occurredAt).toLocaleString()}</time></div>
              <p className="mt-3 break-words text-sm leading-relaxed text-slate-700"><span className="font-semibold text-slate-900">{activity.actorLogin ? `@${activity.actorLogin}` : "Someone"}</span> on <a href={githubUrl(activity.itemUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">#{activity.itemNumber} {activity.itemTitle}</a></p></div></li>)}</ol>}
        {repo.activitiesNextCursor && <button type="button" onClick={() => void loadMore("activities")} disabled={loadingMore === "activities"} className="mt-5 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">{loadingMore === "activities" ? "Loading…" : "Load older activity"}</button>}
      </section>
    </>}
  </main>;
}
