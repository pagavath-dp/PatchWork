import Link from "next/link";
import { Activity, ArrowLeft, ArrowUpRight, CircleAlert, Clock3, GitBranch, Inbox, ListChecks, RotateCw } from "lucide-react";
import type { WorkspaceActivityItem, WorkspaceActivityPage } from "@patchwork/contracts";

function githubUrl(value: string): string {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "#"; }
  catch { return "#"; }
}

function eventText(item: WorkspaceActivityItem): string {
  if (item.source === "GITHUB") return item.event.replaceAll("_", " ");
  return ({ TASK_CREATED: "created a task", TASK_UPDATED: "updated a task",
    GITHUB_ITEM_LINKED: "linked a GitHub item", GITHUB_ITEM_UNLINKED: "unlinked a GitHub item" })[item.kind];
}

export function ActivityTimelineView({ workspaceId, page, items, loading, error, loadingMore, olderError, onRefresh, onLoadMore }: {
  workspaceId: string; page: WorkspaceActivityPage | null; items: WorkspaceActivityItem[];
  loading: boolean; error: string; loadingMore: boolean; olderError: string;
  onRefresh: () => void; onLoadMore: () => void;
}) {
  return <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 lg:px-10">
    <Link href={`/workspaces/${workspaceId}`} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><ArrowLeft aria-hidden="true" size={16} />Workspace dashboard</Link>
    <header className="mb-7 mt-7 flex flex-wrap items-end justify-between gap-5 border-b border-slate-200 pb-7">
      <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Workspace activity</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Team timeline</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">Task changes alongside saved GitHub issue and pull request activity.</p></div>
      <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60"><RotateCw aria-hidden="true" size={16} />Refresh timeline</button>
    </header>
    {page && <section aria-label="GitHub snapshot status" role="status" className={`mb-6 flex gap-3 rounded-2xl border p-4 sm:p-5 ${page.github.snapshotStatus === "fresh" ? "border-indigo-200 bg-indigo-50 text-indigo-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
      <GitBranch aria-hidden="true" size={19} className="mt-0.5 shrink-0" />
      <div className="min-w-0"><p className="text-sm font-semibold">GitHub snapshot: {page.github.snapshotStatus}</p>
        {page.github.lastSyncedAt && <p className="mt-1 text-xs">Last saved {new Date(page.github.lastSyncedAt).toLocaleString()}</p>}
        {page.github.reason && <p className="mt-2 text-sm">{page.github.reason}</p>}
        <p className="mt-2 text-sm">Task activity remains available independently. {page.github.refreshAvailable ? "An owner or admin can refresh GitHub data from the repository page." : "Live GitHub refresh is unavailable."}</p>
        <Link href={`/workspaces/${workspaceId}/repository`} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-indigo-500">Repository details <ArrowUpRight aria-hidden="true" size={14} /></Link>
      </div>
    </section>}
    {loading && <div role="status" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><p className="font-semibold text-slate-800">Loading activity…</p><p className="mt-1 text-sm text-slate-500">Gathering saved task and GitHub events.</p><div aria-hidden="true" className="mt-5 h-20 animate-pulse rounded-xl bg-slate-100" /></div>}
    {error && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-white p-5 text-sm text-rose-800 shadow-sm"><CircleAlert aria-hidden="true" size={19} className="shrink-0" /><p className="flex-1">Could not load activity: {error}</p><button type="button" onClick={onRefresh} disabled={loading} className="rounded-lg bg-indigo-600 px-3 py-2 font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">Try again</button></div>}
    {!loading && page && items.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center shadow-sm"><Inbox aria-hidden="true" size={24} className="mx-auto text-indigo-500" /><h2 className="mt-3 font-semibold text-slate-900">No recorded activity yet</h2><p className="mx-auto mt-1 max-w-md text-sm text-slate-600">New task changes and saved GitHub events will appear here. Existing tasks were not backfilled into this timeline.</p></div>}
    {items.length > 0 && <section aria-label="Combined workspace activity" className="rounded-2xl border border-slate-200 bg-white px-4 py-5 shadow-sm sm:px-7 sm:py-7">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">Recorded events</p><h2 className="mt-1 text-lg font-semibold text-slate-900">Recent activity</h2></div><p className="text-xs text-slate-500">Newest first</p></div>
      <ol className="space-y-0 border-l border-slate-200 pl-5 sm:pl-7">{items.map((item) => <li key={`${item.source}:${item.id}`} className="relative pb-6 last:pb-0">
        <span aria-hidden="true" className={`absolute -left-[29px] top-1 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-white sm:-left-[37px] ${item.source === "TASK" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-700"}`}>{item.source === "TASK" ? <ListChecks size={12} /> : <GitBranch size={12} />}</span>
        <article className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.source === "TASK" ? "bg-indigo-50 text-indigo-700" : "bg-slate-200 text-slate-700"}`}>{item.source === "TASK" ? "Task" : "GitHub"}</span><time dateTime={item.occurredAt} className="inline-flex items-center gap-1.5 text-xs text-slate-500"><Clock3 aria-hidden="true" size={13} />{new Date(item.occurredAt).toLocaleString()}</time></div>
          <p className="mt-3 break-words text-sm leading-relaxed text-slate-700"><span className="font-semibold text-slate-900">{item.actorLogin ? `@${item.actorLogin}` : "Someone"}</span> {eventText(item)}: {item.source === "TASK" ? <span className="font-semibold text-slate-900">{item.taskTitle}</span> :
            <a href={githubUrl(item.itemUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">#{item.itemNumber} {item.itemTitle}</a>}</p>
          {item.source === "TASK" && item.details.changes && item.details.changes.length > 0 && <p className="mt-3 text-xs text-slate-600">Changed: {item.details.changes.map((change) => change.field).join(", ")}</p>}
          {item.source === "TASK" && item.details.item && <p className="mt-3 break-words text-xs text-slate-600">{item.details.item.kind === "ISSUE" ? "Issue" : "PR"} <a href={githubUrl(item.details.item.url)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">#{item.details.item.number}</a> in {item.details.item.repository}</p>}
        </article>
      </li>)}</ol>
    </section>}
    {olderError && <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><CircleAlert aria-hidden="true" size={17} className="mt-0.5 shrink-0" /><p>Could not load older activity: {olderError}</p></div>}
    {page?.nextCursor && <button type="button" onClick={onLoadMore} disabled={loadingMore} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-indigo-700 shadow-sm hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60"><Activity aria-hidden="true" size={16} />{loadingMore ? "Loading…" : "Load older activity"}</button>}
  </div>;
}
