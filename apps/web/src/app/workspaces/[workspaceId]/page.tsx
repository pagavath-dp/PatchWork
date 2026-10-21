"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft, ArrowRight, CircleAlert, GitBranch, LayoutGrid, List, Plus, RotateCw, UsersRound } from "lucide-react";
import { apiRequest, ApiRequestError, type Task, type Workspace } from "@/lib/api";
import { appendUniqueTasks, loadWorkspaceSections, type GitHubItem, type Member, type TaskLink } from "@/lib/workspace-data";
import { KanbanBoard } from "./KanbanBoard";
import { HealthPanel } from "./HealthPanel";
import { TaskMeta, TaskPriorityBadge, TaskStatusBadge } from "./TaskPresentation";

function safeGitHubUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "#";
  } catch { return "#"; }
}

const taskFieldClass = "mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 disabled:opacity-60";
const taskLabelClass = "block text-sm font-semibold text-slate-700";

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
  const [taskLoadError, setTaskLoadError] = useState("");
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const loadMoreInFlight = useRef(false);
  const createInFlight = useRef(false);
  const createTitleRef = useRef<HTMLInputElement>(null);
  const newTaskButtonRef = useRef<HTMLButtonElement>(null);
  const [healthRefreshKey, setHealthRefreshKey] = useState(0);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState("");
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [repositoryError, setRepositoryError] = useState("");
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editRevision, setEditRevision] = useState("");
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
  const [taskConflict, setTaskConflict] = useState(false);
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
      setTaskLoadError("");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setTaskLoadError(reason instanceof Error ? reason.message : "Could not load tasks");
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

  useEffect(() => {
    if (!createOpen) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("create-task")?.scrollIntoView({ behavior: "smooth", block: "start" });
      createTitleRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [createOpen]);

  async function reloadTasks() {
    setLoading(true); setTaskLoadError(""); setError(""); setTaskConflict(false);
    try {
      const [workspaces, result] = await Promise.all([
        apiRequest<Workspace[]>("/api/v1/workspaces"),
        apiRequest<{ items: Task[]; nextCursor: string | null }>(`/api/v1/workspaces/${workspaceId}/tasks`),
      ]);
      setWorkspace(workspaces.find((item) => item.id === workspaceId) ?? null);
      setTasks(result.items); setNextCursor(result.nextCursor); setEditingTaskId(null);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setTaskLoadError(reason instanceof Error ? reason.message : "Could not load tasks");
    } finally { setLoading(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createInFlight.current) return;
    createInFlight.current = true; setSaving(true); setCreateError(""); setError(""); setTaskConflict(false);
    try {
      const task = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks`, {
        method: "POST", body: JSON.stringify({ title, description, status, priority, ...(dueDate ? { dueDate } : {}),
          ...(assigneeId ? { assigneeId } : {}) }),
      });
      setTasks((items) => [task, ...items]);
      setHealthRefreshKey((key) => key + 1);
      setTitle(""); setDescription(""); setDueDate(""); setAssigneeId(""); setStatus("TODO"); setPriority("MEDIUM");
      setCreateOpen(false);
      requestAnimationFrame(() => newTaskButtonRef.current?.focus());
    } catch (reason) { setCreateError(reason instanceof Error ? reason.message : "Could not create task"); }
    finally { createInFlight.current = false; setSaving(false); }
  }

  function closeCreate() {
    if (createInFlight.current) return;
    setCreateOpen(false); setCreateError("");
    setTitle(""); setDescription(""); setDueDate(""); setAssigneeId(""); setStatus("TODO"); setPriority("MEDIUM");
    requestAnimationFrame(() => newTaskButtonRef.current?.focus());
  }

  function startEdit(task: Task) {
    if (editSaving || movingTaskId) return;
    setView("list");
    setEditingTaskId(task.id);
    setEditRevision(task.revision);
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
    if (!canEditTasks || movingTaskId || editSaving || task.status === nextStatus) return;
    setMovingTaskId(task.id); setError(""); setTaskConflict(false);
    try {
      const updated = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks/${task.id}`, {
        method: "PATCH", body: JSON.stringify({ status: nextStatus, expectedRevision: task.revision }),
      });
      setTasks((items) => items.map((item) => item.id === updated.id ? updated : item));
      setHealthRefreshKey((key) => key + 1);
      if (editingTaskId === updated.id) { setEditStatus(updated.status); setEditRevision(updated.revision); }
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else if (reason instanceof ApiRequestError && reason.status === 409) {
        setTaskConflict(true); setError("This task changed in another session. Reload tasks to see the latest status.");
      } else setError(reason instanceof Error ? reason.message : "Could not move task");
    } finally { setMovingTaskId(null); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTaskId || editSaving) return;
    setEditSaving(true); setError(""); setTaskConflict(false);
    try {
      const updated = await apiRequest<Task>(`/api/v1/workspaces/${workspaceId}/tasks/${editingTaskId}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: editRevision, title: editTitle, description: editDescription, status: editStatus, priority: editPriority,
          dueDate: editDueDate || null, ...(!membersLoading && !membersError ? { assigneeId: editAssigneeId || null } : {}) }),
      });
      setTasks((items) => items.map((task) => task.id === updated.id ? updated : task));
      setHealthRefreshKey((key) => key + 1);
      setEditingTaskId(null);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setTaskConflict(true); setError("This task changed in another session. Your draft remains visible; copy it before reloading tasks.");
      } else setError(reason instanceof Error ? reason.message : "Could not update task");
    }
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
    if (!nextCursor || loadMoreInFlight.current) return;
    loadMoreInFlight.current = true; setLoadingMoreTasks(true);
    setError("");
    try {
      const result = await apiRequest<{ items: Task[]; nextCursor: string | null }>(`/api/v1/workspaces/${workspaceId}/tasks?cursor=${encodeURIComponent(nextCursor)}`);
      setTasks((items) => appendUniqueTasks(items, result.items));
      setNextCursor(result.nextCursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load more tasks"); }
    finally { loadMoreInFlight.current = false; setLoadingMoreTasks(false); }
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8 lg:px-10">
      <Link href="/workspaces" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><ArrowLeft aria-hidden="true" size={16} />All workspaces</Link>
      <header className="mb-7 mt-7 flex flex-wrap items-end justify-between gap-5 border-b border-slate-200 pb-7">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Workspace dashboard</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">{workspace?.name ?? (loading ? "Loading…" : "Workspace")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">Plan work, track progress, and keep your team in sync.</p></div>
        {workspace && <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold capitalize text-indigo-700">{workspace.role.toLowerCase()} access</span>}
      </header>
      {workspace && <nav aria-label="Workspace sections" className="mb-7 grid gap-3 sm:grid-cols-3">
        <Link href={`/workspaces/${workspaceId}/members`} className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><UsersRound aria-hidden="true" size={18} className="text-indigo-600" />Members <ArrowRight aria-hidden="true" size={15} className="ml-auto text-slate-400 group-hover:text-indigo-600" /></Link>
        <Link href={`/workspaces/${workspaceId}/activity`} className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><Activity aria-hidden="true" size={18} className="text-indigo-600" />Team timeline <ArrowRight aria-hidden="true" size={15} className="ml-auto text-slate-400 group-hover:text-indigo-600" /></Link>
        <Link href={`/workspaces/${workspaceId}/repository`} className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500"><GitBranch aria-hidden="true" size={18} className="text-indigo-600" />GitHub repository <ArrowRight aria-hidden="true" size={15} className="ml-auto text-slate-400 group-hover:text-indigo-600" /></Link>
      </nav>}
      {workspace && <HealthPanel workspaceId={workspaceId} refreshKey={healthRefreshKey} />}
      {linksLoading && <p role="status" className="mb-3 text-sm text-slate-500">Loading GitHub task links…</p>}
      {linksError && <p role="alert" className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">GitHub task links: {linksError}. Tasks are still available.</p>}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:px-5">
        <div className="flex flex-wrap items-center gap-4">
          <div role="group" className="inline-flex rounded-xl bg-slate-100 p-1" aria-label="Task view">
            <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-indigo-500 ${view === "board" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}><LayoutGrid aria-hidden="true" size={16} />Board</button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-indigo-500 ${view === "list" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}><List aria-hidden="true" size={16} />List</button>
          </div>
          {!loading && !taskLoadError && <p className="text-sm text-slate-500">{tasks.length} {tasks.length === 1 ? "task" : "tasks"} loaded{nextCursor ? " · more available" : ""}</p>}
        </div>
        {canEditTasks ? <button ref={newTaskButtonRef} type="button" aria-expanded={createOpen} aria-controls={createOpen && !loading && !taskLoadError ? "create-task" : undefined} onClick={() => { setCreateOpen(true); if (createOpen) createTitleRef.current?.focus(); }} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><Plus aria-hidden="true" size={17} />New task</button> : workspace?.role === "VIEWER" && <p className="text-sm font-medium text-slate-500">View only access</p>}
      </div>
      {error && <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><CircleAlert aria-hidden="true" size={18} className="shrink-0" /><p className="flex-1">{error}</p>{taskConflict && <button type="button" onClick={() => void reloadTasks()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-2 font-semibold hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-rose-600 disabled:opacity-60"><RotateCw aria-hidden="true" size={15} />Discard draft and reload tasks</button>}</div>}
      {movingTaskId && <p role="status" className="mb-4 text-sm text-indigo-700">Saving task status…</p>}
      <div className={view === "board" ? "space-y-7" : "grid gap-7 xl:grid-cols-[minmax(0,1fr)_360px]"}>
        <section aria-label="Tasks" className="space-y-4">
          {loading ? <div role="status" className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><p className="font-semibold text-slate-800">Loading your tasks…</p><p className="mt-1 text-sm text-slate-500">Getting the latest work from this workspace.</p><div aria-hidden="true" className="mt-6 h-24 animate-pulse rounded-xl bg-slate-100" /></div> : taskLoadError ?
            <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-7 shadow-sm"><CircleAlert aria-hidden="true" size={22} className="text-rose-600" /><h2 className="mt-3 font-semibold text-slate-900">Tasks could not be loaded</h2><p className="mt-1 text-sm text-slate-600">{taskLoadError}</p><button type="button" onClick={() => void reloadTasks()} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><RotateCw aria-hidden="true" size={16} />Try again</button></div> : view === "board" ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-xl font-bold tracking-tight text-slate-900">Task board</h2><p className="mt-1 text-sm text-slate-500">Follow work from planning through completion.</p></div>{canEditTasks && <p className="text-xs font-medium text-slate-500">Drag a card or use Move to</p>}</div>
              <KanbanBoard tasks={tasks} members={members} canMove={canEditTasks} movingTaskId={movingTaskId} onMove={moveTask} onEdit={startEdit} />
              {tasks.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-4 text-sm text-slate-600">{canEditTasks ? "Your board is ready. Choose New task to start tracking work." : "No tasks have been added to this workspace yet."}</p>}
            </>
          ) : tasks.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-slate-600"><h2 className="font-semibold text-slate-900">Nothing in the task list yet</h2><p className="mt-1 text-sm">{canEditTasks ? "Choose New task to add the first piece of work." : "No tasks have been added to this workspace yet."}</p></div> : tasks.map((task) => (
            <article id={`task-${task.id}`} key={task.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              {editingTaskId === task.id ? (
                <form onSubmit={saveEdit} className="space-y-4">
                  <div className="border-b border-slate-100 pb-4"><h2 className="text-lg font-semibold text-slate-900">Edit task</h2><p className="mt-1 text-sm text-slate-500">Update the details your team uses to track this work.</p></div>
                  <div><label htmlFor={`edit-title-${task.id}`} className={taskLabelClass}>Title</label><input id={`edit-title-${task.id}`} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required maxLength={160} className={taskFieldClass} /></div>
                  <div><label htmlFor={`edit-description-${task.id}`} className={taskLabelClass}>Description</label><textarea id={`edit-description-${task.id}`} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} maxLength={5000} rows={3} className={taskFieldClass} /></div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor={`edit-status-${task.id}`} className={taskLabelClass}>Status</label><select id={`edit-status-${task.id}`} value={editStatus} onChange={(event) => setEditStatus(event.target.value as Task["status"])} className={taskFieldClass}><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="IN_REVIEW">In review</option><option value="DONE">Done</option></select></div>
                    <div><label htmlFor={`edit-priority-${task.id}`} className={taskLabelClass}>Priority</label><select id={`edit-priority-${task.id}`} value={editPriority} onChange={(event) => setEditPriority(event.target.value as Task["priority"])} className={taskFieldClass}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor={`edit-due-${task.id}`} className={taskLabelClass}>Due date</label><input id={`edit-due-${task.id}`} type="date" value={editDueDate} onChange={(event) => setEditDueDate(event.target.value)} className={taskFieldClass} /></div>
                    <div><label htmlFor={`edit-assignee-${task.id}`} className={taskLabelClass}>Assignee</label><select id={`edit-assignee-${task.id}`} value={editAssigneeId} onChange={(event) => setEditAssigneeId(event.target.value)} disabled={membersLoading || Boolean(membersError)} className={taskFieldClass}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.githubLogin}</option>)}</select>{membersLoading && <p role="status" className="mt-1 text-xs text-slate-500">Loading members…</p>}{membersError && <p role="alert" className="mt-1 text-xs text-amber-800">Members unavailable: {membersError}. Existing assignment will be kept.</p>}</div>
                  </div>
                  <div className="flex flex-wrap gap-3"><button disabled={editSaving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-60">{editSaving ? "Saving…" : "Save changes"}</button><button type="button" disabled={editSaving} onClick={() => setEditingTaskId(null)} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">Cancel</button></div>
                  <div className="border-t border-slate-200 pt-4">
                    {repositoryLoading && <p role="status" className="text-sm text-slate-500">Loading GitHub items…</p>}
                    {repositoryError && <p role="alert" className="text-sm text-amber-800">GitHub items unavailable: {repositoryError}. Task editing still works.</p>}
                    {repositoryItems.length > 0 ? <><label htmlFor={`link-${task.id}`} className="block text-sm font-medium text-slate-700">Link a verified GitHub issue or pull request</label><div className="mt-2 flex flex-wrap gap-2"><select id={`link-${task.id}`} value={linkItemId} onChange={(event) => setLinkItemId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"><option value="">Choose an item</option>{repositoryItems.map((item) => <option key={item.id} value={item.id}>{item.kind === "ISSUE" ? "Issue" : "PR"} #{item.number}: {item.title}</option>)}</select><button type="button" onClick={() => void addLink(task.id)} disabled={!linkItemId || linkSaving} className="rounded-lg border border-indigo-300 px-3 py-2 font-semibold text-indigo-700 disabled:opacity-60">Add link</button></div><div className="mt-2 flex flex-wrap gap-2">{issueCursor && <button type="button" onClick={() => void loadOlderGitHubItems("ISSUE")} disabled={loadingOlderItems} className="text-xs font-semibold text-indigo-700 disabled:opacity-60">Load older issues</button>}{pullCursor && <button type="button" onClick={() => void loadOlderGitHubItems("PULL_REQUEST")} disabled={loadingOlderItems} className="text-xs font-semibold text-indigo-700 disabled:opacity-60">Load older pull requests</button>}</div></> : !repositoryLoading && !repositoryError && <p className="text-sm text-slate-500">No saved GitHub issues or pull requests to link.</p>}
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="min-w-0 break-words text-lg font-semibold text-slate-900">{task.title}</h2><TaskStatusBadge status={task.status} /></div>
                  {task.description && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{task.description}</p>}
                  <div className="mt-4 flex flex-wrap items-center gap-3"><TaskPriorityBadge priority={task.priority} /><TaskMeta task={task} assigneeName={members.find((member) => member.id === task.assigneeId)?.name ?? members.find((member) => member.id === task.assigneeId)?.githubLogin ?? null} />{canEditTasks && <button type="button" onClick={() => startEdit(task)} className="ml-auto text-sm font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500">Edit details</button>}</div>
                </>
              )}
              {links.some((link) => link.taskId === task.id) && <ul className="mt-4 flex flex-wrap gap-2" aria-label="Linked GitHub items">{links.filter((link) => link.taskId === task.id).map((link) => <li key={link.id} className="inline-flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-xs"><a href={safeGitHubUrl(link.item.htmlUrl)} target="_blank" rel="noopener noreferrer" className="font-semibold text-indigo-700 hover:underline">{link.item.kind === "ISSUE" ? "Issue" : "PR"} #{link.item.number}</a>{canEditTasks && <button type="button" disabled={linkSaving} onClick={() => void unlink(task.id, link.id)} className="text-slate-600 hover:underline" aria-label={`Unlink ${link.item.kind === "ISSUE" ? "issue" : "pull request"} ${link.item.number}`}>Unlink</button>}</li>)}</ul>}
            </article>
          ))}
          {nextCursor && !taskLoadError && <button type="button" onClick={() => void loadMore()} disabled={loadingMoreTasks} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-indigo-700 shadow-sm hover:border-indigo-400 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">{loadingMoreTasks ? "Loading more tasks…" : "Load more tasks"}</button>}
        </section>
        {canEditTasks && !loading && !taskLoadError && createOpen && <form id="create-task" onSubmit={create} className={`scroll-mt-6 self-start rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 ${view === "board" ? "max-w-4xl" : ""}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-5"><div className="flex items-start gap-3"><span className="rounded-lg bg-indigo-50 p-2 text-indigo-700"><Plus aria-hidden="true" size={20} /></span><div><h2 className="text-lg font-semibold text-slate-900">Create a task</h2><p className="mt-1 text-sm text-slate-500">Capture the next piece of work for your team.</p></div></div><button type="button" onClick={closeCreate} disabled={saving} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">Cancel</button></div>
          {createError && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">Could not create task: {createError}. Your entries are still here; try again.</p>}
          <div className="mt-5 space-y-4">
            <div><label className={taskLabelClass} htmlFor="task-title">Title</label><input ref={createTitleRef} id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} className={taskFieldClass} placeholder="Define API contracts" /></div>
            <div><label className={taskLabelClass} htmlFor="task-description">Description</label><textarea id="task-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} className={taskFieldClass} placeholder="Add context, decisions, or acceptance notes" /></div>
            <div className={`grid gap-4 ${view === "board" ? "sm:grid-cols-2" : ""}`}>
              <div><label className={taskLabelClass} htmlFor="task-status">Status</label><select id="task-status" value={status} onChange={(event) => setStatus(event.target.value as Task["status"])} className={taskFieldClass}><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="IN_REVIEW">In review</option><option value="DONE">Done</option></select></div>
              <div><label className={taskLabelClass} htmlFor="task-priority">Priority</label><select id="task-priority" value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])} className={taskFieldClass}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></div>
            </div>
            <div className={`grid gap-4 ${view === "board" ? "sm:grid-cols-2" : ""}`}>
              <div><label className={taskLabelClass} htmlFor="task-due">Due date</label><input id="task-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className={taskFieldClass} /></div>
              <div><label className={taskLabelClass} htmlFor="task-assignee">Assignee</label><select id="task-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={membersLoading || Boolean(membersError)} className={taskFieldClass}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name ?? member.githubLogin}</option>)}</select>{membersLoading && <p role="status" className="mt-2 text-xs text-slate-500">Loading members…</p>}{membersError && <p role="alert" className="mt-2 text-xs text-amber-800">Members unavailable: {membersError}. You can create an unassigned task.</p>}</div>
            </div>
          </div>
          <button disabled={saving} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-60"><Plus aria-hidden="true" size={17} />{saving ? "Creating…" : "Create task"}</button>
        </form>}
      </div>
    </div>
  );
}
