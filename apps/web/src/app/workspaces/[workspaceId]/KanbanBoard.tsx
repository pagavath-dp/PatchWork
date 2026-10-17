"use client";

import { useState } from "react";
import type { Task } from "@/lib/api";

type TaskStatus = Task["status"];

const columns: { status: TaskStatus; label: string; accent: string; badge: string }[] = [
  { status: "TODO", label: "To do", accent: "bg-slate-400", badge: "bg-slate-100 text-slate-700" },
  { status: "IN_PROGRESS", label: "In progress", accent: "bg-blue-500", badge: "bg-blue-50 text-blue-700" },
  { status: "IN_REVIEW", label: "In review", accent: "bg-amber-500", badge: "bg-amber-50 text-amber-800" },
  { status: "DONE", label: "Done", accent: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700" },
];

const priorityStyle: Record<Task["priority"], string> = {
  LOW: "bg-slate-100 text-slate-600",
  MEDIUM: "bg-blue-50 text-blue-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-rose-50 text-rose-700",
};

type Props = {
  tasks: Task[];
  canMove: boolean;
  movingTaskId: string | null;
  onMove: (task: Task, status: TaskStatus) => void;
  onEdit: (task: Task) => void;
};

export function KanbanBoard({ tasks, canMove, movingTaskId, onMove, onEdit }: Props) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [hoveredStatus, setHoveredStatus] = useState<TaskStatus | null>(null);

  return (
    <section aria-label="Kanban board" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {columns.map(({ status, label, accent, badge }) => {
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
            className={`min-h-64 rounded-2xl border p-3 transition-colors ${hoveredStatus === status ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-100/70"}`}
          >
            <header className="mb-3 flex items-center gap-2 px-1 py-1">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${accent}`} />
              <h2 className="font-semibold text-slate-900">{label}</h2>
              <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-bold ${badge}`}>{columnTasks.length}</span>
            </header>
            <div className="space-y-3">
              {columnTasks.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-8 text-center text-sm text-slate-500">No tasks here yet</p>
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
                  className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${canMove ? "cursor-grab active:cursor-grabbing" : ""} ${movingTaskId === task.id ? "opacity-60" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 font-semibold leading-snug text-slate-900 break-words">{task.title}</h3>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${priorityStyle[task.priority]}`}>{task.priority.toLowerCase()}</span>
                  </div>
                  {task.description && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">{task.description}</p>}
                  {task.dueDate && <p className="mt-3 text-xs font-medium text-slate-500">Due {task.dueDate}</p>}
                  {canMove && (
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <label htmlFor={`move-${task.id}`} className="block text-xs font-medium text-slate-500">Move to</label>
                      <select
                        id={`move-${task.id}`}
                        aria-label={`Move ${task.title} to`}
                        value={task.status}
                        onChange={(event) => onMove(task, event.target.value as TaskStatus)}
                        disabled={movingTaskId !== null}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 disabled:opacity-60"
                      >
                        {columns.map((column) => <option key={column.status} value={column.status}>{column.label}</option>)}
                      </select>
                      <button type="button" onClick={() => onEdit(task)} className="mt-2 text-xs font-semibold text-indigo-700 hover:underline">Edit details</button>
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
