"use client";

import { useState } from "react";
import { ArrowUpRight, GripVertical } from "lucide-react";
import type { Task } from "@/lib/api";
import type { Member } from "@/lib/workspace-data";
import { TaskMeta, TaskPriorityBadge, taskStatuses } from "./TaskPresentation";

type TaskStatus = Task["status"];

const columns: { status: TaskStatus; accent: string }[] = [
  { status: "TODO", accent: "bg-slate-400" },
  { status: "IN_PROGRESS", accent: "bg-blue-500" },
  { status: "IN_REVIEW", accent: "bg-amber-500" },
  { status: "DONE", accent: "bg-emerald-500" },
];

type Props = {
  tasks: Task[];
  members: Member[];
  canMove: boolean;
  movingTaskId: string | null;
  onMove: (task: Task, status: TaskStatus) => void;
  onEdit: (task: Task) => void;
};

export function KanbanBoard({ tasks, members, canMove, movingTaskId, onMove, onEdit }: Props) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [hoveredStatus, setHoveredStatus] = useState<TaskStatus | null>(null);

  return (
    <section aria-label="Kanban board" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {columns.map(({ status, accent }) => {
        const label = taskStatuses[status].label;
        const columnTasks = tasks.filter((task) => task.status === status);
        return (
          <div
            key={status}
            aria-label={`${label} column`}
            onDragOver={(event) => {
              if (!canMove || !draggedTaskId || movingTaskId) return;
              event.preventDefault();
              setHoveredStatus(status);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const task = tasks.find((item) => item.id === event.dataTransfer.getData("text/plain"));
              setDraggedTaskId(null);
              setHoveredStatus(null);
              if (canMove && !movingTaskId && task && task.status !== status) onMove(task, status);
            }}
            className={`min-w-0 rounded-2xl border p-3 transition-colors ${hoveredStatus === status ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-100" : "border-slate-200 bg-slate-50"}`}
          >
            <header className="mb-3 flex items-center gap-2 px-1 py-2">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${accent}`} />
              <h2 className="text-sm font-bold text-slate-900">{label}</h2>
              <span className={`ml-auto rounded-full px-2.5 py-1 text-xs font-bold ${taskStatuses[status].surface} ${taskStatuses[status].color}`} aria-label={`${columnTasks.length} loaded tasks`}>{columnTasks.length}</span>
            </header>
            <div className="space-y-3 md:min-h-48">
              {columnTasks.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white/80 px-4 py-8 text-center text-sm text-slate-500">No tasks in {label.toLowerCase()}</p>
              )}
              {columnTasks.map((task) => (
                <article
                  key={task.id}
                  draggable={canMove && movingTaskId === null}
                  onDragStart={(event) => {
                    if (!canMove) return;
                    event.dataTransfer.setData("text/plain", task.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedTaskId(task.id);
                  }}
                  onDragEnd={() => { setDraggedTaskId(null); setHoveredStatus(null); }}
                  className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${canMove ? "cursor-grab active:cursor-grabbing" : ""} ${movingTaskId === task.id ? "opacity-60" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 break-words text-sm font-semibold leading-snug text-slate-900">{task.title}</h3>
                    {canMove && <GripVertical aria-hidden="true" size={16} className="shrink-0 text-slate-300" />}
                  </div>
                  {task.description && <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{task.description}</p>}
                  <div className="mt-4"><TaskPriorityBadge priority={task.priority} /></div>
                  <div className="mt-4 border-t border-slate-100 pt-3"><TaskMeta task={task} assigneeName={members.find((member) => member.id === task.assigneeId)?.name ?? members.find((member) => member.id === task.assigneeId)?.githubLogin ?? null} /></div>
                  {canMove && (
                    <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 pt-3">
                      <div className="min-w-32 flex-1"><label htmlFor={`move-${task.id}`} className="block text-xs font-semibold text-slate-600">Move to</label>
                      <select
                        id={`move-${task.id}`}
                        aria-label={`Move ${task.title} to`}
                        value={task.status}
                        onChange={(event) => onMove(task, event.target.value as TaskStatus)}
                        disabled={movingTaskId !== null}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60"
                      >
                        {columns.map((column) => <option key={column.status} value={column.status}>{taskStatuses[column.status].label}</option>)}
                      </select></div>
                      <button type="button" onClick={() => onEdit(task)} disabled={movingTaskId !== null} className="inline-flex items-center gap-1 py-1.5 text-xs font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60">Edit <ArrowUpRight aria-hidden="true" size={14} /></button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
