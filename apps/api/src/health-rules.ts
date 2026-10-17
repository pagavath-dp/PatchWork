import type { HealthFinding, HealthReport } from "@patchwork/contracts";

const DAY_MS = 86_400_000;
const SNAPSHOT_FRESH_MS = DAY_MS;

export type HealthTask = {
  id: string;
  title: string;
  status: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
  dueDate: Date | null;
  assigneeId: string | null;
  updatedAt: Date;
};
export type HealthMember = { userId: string; githubLogin: string; name: string | null };
export type HealthPull = { id: string; number: number; title: string; state: string; updatedAt: Date; htmlUrl: string };
export type HealthConnection = { lastSyncedAt: Date | null; lastSyncError: string | null; disconnectedAt: Date | null };
export type HealthInput = {
  now: Date;
  timeZone: string;
  tasks: HealthTask[];
  members: HealthMember[];
  connection: HealthConnection | null;
  pulls: HealthPull[];
  githubConfigured: boolean;
};

function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

function elapsedDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

export function evaluateHealth(input: HealthInput): HealthReport {
  const { now, timeZone, tasks, members, connection, pulls, githubConfigured } = input;
  const today = dateInZone(now, timeZone);
  const findings: HealthFinding[] = [];
  const unfinished = tasks.filter((task) => task.status !== "DONE");

  for (const task of unfinished) {
    if (task.dueDate) {
      const due = task.dueDate.toISOString().slice(0, 10);
      const daysOverdue = calendarDaysBetween(due, today);
      if (daysOverdue > 0) findings.push({
        id: `overdue:${task.id}`, rule: "OVERDUE_TASK", severity: daysOverdue >= 3 ? "CRITICAL" : "WARNING",
        title: `Overdue task: ${task.title}`,
        explanation: `This unfinished task is ${daysOverdue} calendar ${daysOverdue === 1 ? "day" : "days"} past its due date in the workspace time zone.`,
        evidence: [{ label: "Due date", value: due }, { label: "Status", value: task.status }, { label: "Days overdue", value: String(daysOverdue) }],
        suggestedAction: "Confirm the next step with the assignee and update the due date or task status.",
      });
    }
    if (task.status === "IN_REVIEW") {
      const idleDays = elapsedDays(task.updatedAt, now);
      if (idleDays >= 3) findings.push({
        id: `review:${task.id}`, rule: "REVIEW_IDLE", severity: idleDays >= 7 ? "CRITICAL" : "WARNING",
        title: `Review-stage work is idle: ${task.title}`,
        explanation: `This task is in review and has had no task update for ${idleDays} days. Reviewer requests and review decisions are not available.`,
        evidence: [{ label: "Status", value: task.status }, { label: "Last task update", value: task.updatedAt.toISOString() }, { label: "Idle days", value: String(idleDays) }],
        suggestedAction: "Check whether a reviewer is assigned and record the next review action on the task.",
      });
    }
  }

  const counts = members.map((member) => ({ member, count: unfinished.filter((task) => task.assigneeId === member.userId).length }));
  counts.sort((a, b) => b.count - a.count || a.member.githubLogin.localeCompare(b.member.githubLogin));
  const busiest = counts[0];
  const leastBusy = counts.at(-1);
  if (members.length >= 2 && busiest && leastBusy && busiest.count >= 3 &&
      busiest.count - leastBusy.count >= 3 && (leastBusy.count === 0 || busiest.count >= 2 * leastBusy.count)) {
    findings.push({
      id: "workload:assigned", rule: "WORKLOAD_IMBALANCE",
      severity: busiest.count >= 6 && busiest.count - leastBusy.count >= 5 ? "CRITICAL" : "WARNING",
      title: "Assigned task workload is uneven",
      explanation: "Unfinished assigned tasks are concentrated on one workspace member. Task effort and capacity are not measured.",
      evidence: [
        { label: "Most assigned", value: `${busiest.member.name ?? busiest.member.githubLogin}: ${busiest.count}` },
        { label: "Fewest assigned", value: `${leastBusy.member.name ?? leastBusy.member.githubLogin}: ${leastBusy.count}` },
        { label: "Unassigned tasks", value: String(unfinished.filter((task) => !task.assigneeId).length) },
      ],
      suggestedAction: "Review capacity with the team and redistribute suitable unfinished tasks.",
    });
  }

  let snapshotStatus: HealthReport["github"]["snapshotStatus"] = "unavailable";
  let reason: string | null = null;
  if (!connection) reason = "No GitHub repository is connected.";
  else if (!connection.lastSyncedAt) reason = "No GitHub snapshot has been saved.";
  else {
    snapshotStatus = now.getTime() - connection.lastSyncedAt.getTime() > SNAPSHOT_FRESH_MS ? "stale" : "fresh";
    if (connection.disconnectedAt) reason = "The repository is disconnected; only saved data is available.";
    else if (!githubConfigured) reason = "GitHub App configuration is missing; live refresh is unavailable.";
    else if (connection.lastSyncError) reason = "The last refresh failed; showing the previous saved snapshot.";
    else if (snapshotStatus === "stale") reason = "The saved GitHub snapshot is more than 24 hours old.";
    for (const pull of pulls) {
      if (pull.state.toUpperCase() !== "OPEN") continue;
      const idleDays = elapsedDays(pull.updatedAt, connection.lastSyncedAt);
      if (idleDays < 7) continue;
      findings.push({
        id: `pull:${pull.id}`, rule: "STALE_PULL_REQUEST", severity: idleDays >= 14 ? "CRITICAL" : "WARNING",
        title: `Stale open pull request #${pull.number}: ${pull.title}`,
        explanation: `At the last snapshot, this open pull request had not been updated for ${idleDays} days. Its current state and review decisions are not available.`,
        evidence: [{ label: "Last PR update", value: pull.updatedAt.toISOString() },
          { label: "Snapshot saved", value: connection.lastSyncedAt.toISOString() },
          { label: "Idle days at snapshot", value: String(idleDays) },
          { label: "GitHub URL", value: pull.htmlUrl }],
        suggestedAction: "Open the pull request, check its current state, and agree on the next review or merge step.",
      });
    }
  }

  const severityOrder = { CRITICAL: 0, WARNING: 1 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.id.localeCompare(b.id));
  return {
    evaluatedAt: now.toISOString(), workspaceTimeZone: timeZone,
    github: { snapshotStatus, lastSyncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
      refreshAvailable: Boolean(connection && !connection.disconnectedAt && githubConfigured), reason },
    taskCounts: { total: tasks.length, unfinished: unfinished.length, unassigned: unfinished.filter((task) => !task.assigneeId).length },
    findings,
  };
}
