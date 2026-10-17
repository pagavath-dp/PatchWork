"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiRequest, ApiRequestError, type Task, type Workspace } from "@/lib/api";
import { loadWorkspaceSections, type GitHubItem, type Member, type TaskLink } from "@/lib/workspace-data";
import { KanbanBoard } from "./KanbanBoard";
import { HealthPanel } from "./HealthPanel";

function safeGitHubUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "#";
  } catch { return "#"; }
}

export default function WorkspacePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [view, setView] = useState<"board" | "list">("board");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Task["status"]>("TODO");
  const [priority, setPriority] = useState<Task["priority"]>("MEDIUM");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [repositoryItems, setRepositoryItems] = useState<GitHubItem[]>([]);
  const [issueCursor, setIssueCursor] = useState<string | null>(null);
  const [pullCursor, setPullCursor] = useState<string | null>(null);
  const [loadingOlderItems, setLoadingOlderItems] = useState(false);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [linkItemId, setLinkItemId] = useState("");
  const [loading, setLoading] = useState(true);
  const [healthRefreshKey, setHealthRefreshKey] = useState(0);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [repositoryError, setRepositoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStatus, setEditStatus] = useState<Task["status"]>("TODO");
  const [editPriority, setEditPriority] = useState<Task["priority"]>("MEDIUM");
  const [editDueDate, setEditDueDate] = useState("");
  const [editAssigneeId, setEditAssigneeId] = useState("");
  const [linkSaving, setLinkSaving] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const canEditTasks = workspace !== null && workspace.role !== "VIEWER";

  useEffect(() => {
    let cancelled = false;
    const sections = loadWorkspaceSections(workspaceId);
    const handleSecondaryError = (reason: unknown, fallback: string, setSectionError: (message: string) => void) => {
      if (cancelled) return;
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setSectionError(reason instanceof Error ? reason.message : fallback);
    };
    void sections.core.then(([workspaces, result]) => {
      if (cancelled) return;
      setWorkspace(workspaces.find((item) => item.id === workspaceId) ?? null);
      setTasks(result.items);
      setNextCursor(result.nextCursor);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Could not load tasks");
    }).finally(() => { if (!cancelled) setLoading(false); });
    void sections.members.then((workspaceMembers) => {
      if (!cancelled) setMembers(workspaceMembers);
    }).catch((reason: unknown) => handleSecondaryError(reason, "Could not load workspace members", setMembersError))
      .finally(() => { if (!cancelled) setMembersLoading(false); });
    void sections.links.then((taskLinks) => {
      if (!cancelled) setLinks(taskLinks);
    }).catch((reason: unknown) => handleSecondaryError(reason, "Could not load task links", setLinksError))
      .finally(() => { if (!cancelled) setLinksLoading(false); });
    void sections.repository.then((repositoryData) => {
      if (cancelled) return;
      setRepositoryItems([...(repositoryData.repository?.issues ?? []).map((item) => ({ ...item, kind: "ISSUE" as const })),
        ...(repositoryData.repository?.pulls ?? []).map((item) => ({ ...item, kind: "PULL_REQUEST" as const }))]);
      setIssueCursor(repositoryData.repository?.issuesNextCursor ?? null);
      setPullCursor(repositoryData.repository?.pullsNextCursor ?? null);
    }).catch((reason: unknown) => handleSecondaryError(reason, "Could not load repository items", setRepositoryError))
      .finally(() => { if (!cancelled) setRepositoryLoading(false); });
    return () => { cancelled = true; };
  }, [router, workspaceId]);

  useEffect(() => {
    if (view === "list" && editingTaskId) {
      document.getElementById(`task-${editingTaskId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [view, editingTaskId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const task = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks`, {
        method: "POST", body: JSON.stringify({ title, description, status, priority, ...(dueDate ? { dueDate } : {}),
          ...(assigneeId ? { assigneeId } : {}) }),
      });
      setTasks((items) => [task, ...items]);
      setHealthRefreshKey((key) => key + 1);
      setTitle(""); setDescription(""); setDueDate(""); setAssigneeId(""); setStatus("TODO"); setPriority("MEDIUM");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create task"); }
    finally { setSaving(false); }
  }

  function startEdit(task: Task) {
    setView("list");
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditStatus(task.status);
    setEditPriority(task.priority);
    setEditDueDate(task.dueDate ?? "");
    setEditAssigneeId(task.assigneeId ?? "");
    setLinkItemId("");
    setError("");
  }

  async function moveTask(task: Task, nextStatus: Task["status"]) {
    if (!canEditTasks || movingTaskId || task.status === nextStatus) return;
    setMovingTaskId(task.id); setError("");
    try {
      const updated = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks/${task.id}`, {
        method: "PATCH", body: JSON.stringify({ status: nextStatus }),
      });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setHealthRefreshKey((key) => key + 1);
      if (editingTaskId === updated.id) setEditStatus(updated.status);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Could not move task");
    } finally { setMovingTaskId(null); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTaskId) return;
    setEditSaving(true); setError("");
    try {
      const updated = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks/${editingTaskId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle, description: editDescription, status: editStatus, priority: editPriority,
          dueDate: editDueDate || null, ...(!membersLoading && !membersError ? { assigneeId: editAssigneeId || null } : {}) }),
      });
      setTasks((items) => items.map((task) => task.id === updated.id ? updated : task));
      setHealthRefreshKey((key) => key + 1);
      setEditingTaskId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update task"); }
    finally { setEditSaving(false); }
  }

  async function addLink(taskId: string) {
    if (!linkItemId) return;
    setLinkSaving(true); setLinksError("");
    try {
      await apiRequest(`/api/v1/workspaces/${workspaceId}/tasks/${taskId}/github-links`,
        { method: "POST", body: JSON.stringify({ itemId: linkItemId }) });
      setLinks(await apiRequest<TaskLink[]>(`/api/v1/workspaces/${workspaceId}/github-links`));
      setLinkItemId("");
    } catch (reason) { setLinksError(reason instanceof Error ? reason.message : "Could not link GitHub item"); }
    finally { setLinkSaving(false); }
  }

  async function unlink(taskId: string, linkId: string) {
    setLinkSaving(true); setLinksError("");
    try {
      await apiRequest(`/api/v1/workspaces/${workspaceId}/tasks/${taskId}/github-links/${linkId}/unlink`, { method: "POST" });
      setLinks((items) => items.filter((item) => item.id !== linkId));
    } catch (reason) { setLinksError(reason instanceof Error ? reason.message : "Could not unlink GitHub item"); }
    finally { setLinkSaving(false); }
  }

  async function loadOlderGitHubItems(kind: "ISSUE" | "PULL_REQUEST") {
    const cursor = kind === "ISSUE" ? issueCursor : pullCursor;
    if (!cursor || loadingOlderItems) return;
    setLoadingOlderItems(true); setRepositoryError("");
    try {
      const result = await apiRequest<{ items: GitHubItem[]; nextCursor: string | null }>(
        `/api/v1/workspaces/${workspaceId}/repository/items?kind=${kind}&cursor=${encodeURIComponent(cursor)}`);
      setRepositoryItems((items) => [...items, ...result.items.map((item) => ({ ...item, kind }))]);
      if (kind === "ISSUE") setIssueCursor(result.nextCursor);
      else setPullCursor(result.nextCursor);
    } catch (reason) { setRepositoryError(reason instanceof Error ? reason.message : "Could not load older GitHub items"); }
    finally { setLoadingOlderItems(false); }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setError("");
    try {
      const result = await apiRequest<{ items: Task[]; nextCursor: string | null }>(`/api/v1/workspaces/${workspaceId}/tasks?cursor=${encodeURIComponent(nextCursor)}`);
      setTasks((items) => [...items, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load more tasks"); }
  }

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <Link href="/workspaces" className="text-sm font-semibold text-indigo-700 hover:underline">← All workspaces</Link>
      <header className="mt-6 mb-8"><p className="text-sm font-bold uppercase tracking-[0.2em] text-indigo-600">Workspace</p><h1 className="mt-2 text-3xl font-bold text-slate-900">{workspace?.name ?? (loading ? "Loading…" : "Workspace")}</h1><p className="mt-2 text-slate-600">Tasks persist in your team workspace.</p></header>
      {workspace && <Link href={`/workspaces/${workspaceId}/repository`} className="mb-6 inline-flex rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">View GitHub repository →</Link>}
      {workspace && <HealthPanel workspaceId={workspaceId} refreshKey={healthRefreshKey} />}
      {linksLoading && <p role="status" className="mb-3 text-sm text-slate-500">Loading GitHub task links…</p>}
      {linksError && <p role="alert" className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">GitHub task links: {linksError}. Tasks are still available.</p>}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="group" className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Task view">
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === "board" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>Board</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === "list" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>List</button>
        </div>
        {workspace?.role === "VIEWER" && <p className="text-sm text-slate-500">View only access</p>}
      </div>
      {error && <p role="alert" className="mb-6 rounded-xl bg-rose-50 p-4 text-rose-700">{error}</p>}
      {movingTaskId && <p role="status" className="mb-4 text-sm text-indigo-700">Saving task status…</p>}
      <div className={view === "board" ? "space-y-7" : "grid gap-7 md:grid-cols-[minmax(0,1fr)_340px]"}>
        <section aria-label="Tasks" className="space-y-4">
          {loading ? <p role="status" className="rounded-2xl border border-slate-200 bg-white p-8 text-slate-600">Loading tasks…</p> : view === "board" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold text-slate-900">Kanban board</h2><p className="text-sm text-slate-500">{tasks.length} loaded {tasks.length === 1 ? "task" : "tasks"}{canEditTasks ? " · Drag a card or use Move to" : ""}</p></div>
              <KanbanBoard tasks={tasks} canMove={canEditTasks} movingTaskId={movingTaskId} onMove={moveTask} onEdit={startEdit} />
              {tasks.length === 0 && <p className="text-sm text-slate-500">No tasks yet. Create one below to start the board.</p>}
            </>
          ) : tasks.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-slate-600">No tasks yet. Add the first piece of work.</div> : tasks.map((task) => (
            <article id={`task-${task.id}`} key={task.id} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              {editingTaskId === task.id ? (
                <form onSubmit={saveEdit} className="space-y-4">
                  <div><label htmlFor={`edit-title-${task.id}`} className="block text-sm font-medium text-slate-700">Title</label><input id={`edit-title-${task.id}`} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required maxLength={160} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></div>
                  <div><label htmlFor={`edit-description-${task.id}`} className="block text-sm font-medium text-slate-700">Description</label><textarea id={`edit-description-${task.id}`} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} maxLength={5000} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor={`edit-status-${task.id}`} className="block text-sm font-medium text-slate-700">Status</label><select id={`edit-status-${task.id}`} value={editStatus} onChange={(event) => setEditStatus(event.target.value as Task["status"])} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="IN_REVIEW">In review</option><option value="DONE">Done</option></select></div>
                    <div><label htmlFor={`edit-priority-${task.id}`} className="block text-sm font-medium text-slate-700">Priority</label><select id={`edit-priority-${task.id}`} value={editPriority} onChange={(event) => setEditPriority(event.target.value as Task["priority"])} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor={`edit-due-${task.id}`} className="block text-sm font-medium text-slate-700">Due date</label><input id={`edit-due-${task.id}`} type="date" value={editDueDate} onChange={(event) => setEditDueDate(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" /></div>
                    <div><label htmlFor={`edit-assignee-${task.id}`} className="block text-sm font-medium text-slate-700">Assignee</label><select id={`edit-assignee-${task.id}`} value={editAssigneeId} onChange={(event) => setEditAssigneeId(event.target.value)} disabled={membersLoading || Boolean(membersError)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-60"><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.githubLogin}</option>)}</select>{membersLoading && <p role="status" className="mt-1 text-xs text-slate-500">Loading members…</p>}{membersError && <p role="alert" className="mt-1 text-xs text-amber-800">Members unavailable: {membersError}. Existing assignment will be kept.</p>}</div>
                  </div>
                  <div className="flex gap-3"><button disabled={editSaving} className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white disabled:opacity-60">{editSaving ? "Saving…" : "Save changes"}</button><button type="button" onClick={() => setEditingTaskId(null)} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700">Cancel</button></div>
                  <div className="border-t border-slate-200 pt-4">
                    {repositoryLoading && <p role="status" className="text-sm text-slate-500">Loading GitHub items…</p>}
                    {repositoryError && <p role="alert" className="text-sm text-amber-800">GitHub items unavailable: {repositoryError}. Task editing still works.</p>}
                    {repositoryItems.length > 0 ? <><label htmlFor={`link-${task.id}`} className="block text-sm font-medium text-slate-700">Link a verified GitHub issue or pull request</label><div className="mt-2 flex flex-wrap gap-2"><select id={`link-${task.id}`} value={linkItemId} onChange={(event) => setLinkItemId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"><option value="">Choose an item</option>{repositoryItems.map((item) => <option key={item.id} value={item.id}>{item.kind === "ISSUE" ? "Issue" : "PR"} #{item.number}: {item.title}</option>)}</select><button type="button" onClick={() => void addLink(task.id)} disabled={!linkItemId || linkSaving} className="rounded-lg border border-indigo-300 px-3 py-2 font-semibold text-indigo-700 disabled:opacity-60">Add link</button></div><div className="mt-2 flex flex-wrap gap-2">{issueCursor && <button type="button" onClick={() => void loadOlderGitHubItems("ISSUE")} disabled={loadingOlderItems} className="text-xs font-semibold text-indigo-700 disabled:opacity-60">Load older issues</button>}{pullCursor && <button type="button" onClick={() => void loadOlderGitHubItems("PULL_REQUEST")} disabled={loadingOlderItems} className="text-xs font-semibold text-indigo-700 disabled:opacity-60">Load older pull requests</button>}</div></> : !repositoryLoading && !repositoryError && <p className="text-sm text-slate-500">No saved GitHub issues or pull requests to link.</p>}
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold text-slate-900">{task.title}</h2><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{task.status.replaceAll("_", " ").toLowerCase()}</span></div>
                  {task.description && <p className="mt-3 whitespace-pre-wrap text-slate-600">{task.description}</p>}
                  <div className="mt-4 flex items-center justify-between gap-3"><p className="text-sm text-slate-500">Priority: {task.priority.toLowerCase()}{task.dueDate ? ` · Due ${task.dueDate}` : ""}{task.assigneeId ? ` · Assigned to ${members.find((member) => member.id === task.assigneeId)?.name ?? members.find((member) => member.id === task.assigneeId)?.githubLogin ?? "member"}` : ""}</p>{canEditTasks && <button onClick={() => startEdit(task)} className="text-sm font-semibold text-indigo-700 hover:underline">Edit</button>}</div>
                </>
              )}
              {links.some((link) => link.taskId === task.id) && <ul className="mt-4 flex flex-wrap gap-2" aria-label="Linked GitHub items">{links.filter((link) => link.taskId === task.id).map((link) => <li key={link.id} className="inline-flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-xs"><a href={safeGitHubUrl(link.item.htmlUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline">{link.item.kind === "ISSUE" ? "Issue" : "PR"} #{link.item.number}</a>{canEditTasks && <button type="button" disabled={linkSaving} onClick={() => void unlink(task.id, link.id)} className="text-slate-600 hover:underline" aria-label={`Unlink ${link.item.kind === "ISSUE" ? "issue" : "pull request"} ${link.item.number}`}>Unlink</button>}</li>)}</ul>}
            </article>
          ))}
          {nextCursor && <button onClick={loadMore} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 font-semibold text-indigo-700 hover:border-indigo-400">Load more tasks</button>}
        </section>
        {canEditTasks && <form onSubmit={create} className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm ${view === "board" ? "max-w-xl" : "self-start"}`}>
          <h2 className="text-lg font-semibold text-slate-900">Create task</h2>
          <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="task-title">Title</label>
          <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="Define API contracts" />
          <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="task-description">Description</label>
          <textarea id="task-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2" />
          <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="task-status">Status</label>
          <select id="task-status" value={status} onChange={(event) => setStatus(event.target.value as Task["status"])} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="IN_REVIEW">In review</option><option value="DONE">Done</option></select>
          <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="task-priority">Priority</label>
          <select id="task-priority" value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select>
          <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="task-due">Due date</label>
          <input id="task-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2" />
          <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="task-assignee">Assignee</label>
          <select id="task-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={membersLoading || Boolean(membersError)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-60"><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.githubLogin}</option>)}</select>
          {membersLoading && <p role="status" className="mt-2 text-xs text-slate-500">Loading members…</p>}
          {membersError && <p role="alert" className="mt-2 text-xs text-amber-800">Members unavailable: {membersError}. You can create an unassigned task.</p>}
          <button disabled={saving} className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{saving ? "Creating…" : "Create task"}</button>
        </form>}
      </div>
    </div>
  );
}
