import { CalendarDays, UserRound } from "lucide-react";
import type { Task } from "@/lib/api";

export const taskStatuses: Record<Task["status"], { label: string; color: string; surface: string }> = {
  TODO: { label: "To do", color: "text-slate-700", surface: "bg-slate-100" },
  IN_PROGRESS: { label: "In progress", color: "text-blue-800", surface: "bg-blue-50" },
  IN_REVIEW: { label: "In review", color: "text-amber-800", surface: "bg-amber-50" },
  DONE: { label: "Done", color: "text-emerald-800", surface: "bg-emerald-50" },
};

const taskPriorities: Record<Task["priority"], { label: string; className: string }> = {
  LOW: { label: "Low", className: "bg-slate-100 text-slate-700" },
  MEDIUM: { label: "Medium", className: "bg-indigo-50 text-indigo-700" },
  HIGH: { label: "High", className: "bg-orange-50 text-orange-800" },
  URGENT: { label: "Urgent", className: "bg-rose-50 text-rose-800" },
};

export function TaskStatusBadge({ status }: { status: Task["status"] }) {
  const details = taskStatuses[status];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${details.surface} ${details.color}`}>
    {details.label}
  </span>;
}

export function TaskPriorityBadge({ priority }: { priority: Task["priority"] }) {
  const details = taskPriorities[priority];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${details.className}`}>
    {details.label} priority
  </span>;
}

export function TaskMeta({ task, assigneeName }: { task: Task; assigneeName: string | null }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium text-slate-500">
    {task.dueDate && <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden="true" size={14} />Due {task.dueDate}</span>}
    <span className="inline-flex min-w-0 items-center gap-1.5"><UserRound aria-hidden="true" size={14} />
      <span className="truncate">{task.assigneeId ? assigneeName ?? "Team member" : "Unassigned"}</span>
    </span>
  </div>;
}
