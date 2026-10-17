"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { HealthReport } from "@patchwork/contracts";
import { apiRequest, ApiRequestError } from "../../../lib/api";

export function HealthPanelView({ report, loading, error, workspaceId }: {
  report: HealthReport | null; loading: boolean; error: string; workspaceId: string;
}) {
  return <section aria-label="Project health" className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">Engineering intelligence</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Project health</h2>
        <p className="mt-1 text-sm text-slate-600">Deterministic signals from workspace tasks and saved GitHub data.</p></div>
      {report && <p className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{report.findings.length} {report.findings.length === 1 ? "finding" : "findings"}</p>}
    </div>
    {loading && <p role="status" className="mt-5 text-sm text-slate-600">Checking project health…</p>}
    {error && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">Could not load project health: {error}</p>}
    {!loading && !error && report && <>
      <div className={`mt-5 rounded-xl p-4 text-sm ${report.github.snapshotStatus === "unavailable" ? "bg-amber-50 text-amber-900" : report.github.snapshotStatus === "stale" ? "bg-amber-50 text-amber-900" : "bg-indigo-50 text-indigo-900"}`}>
        <p className="font-semibold">GitHub data: {report.github.snapshotStatus === "unavailable" ? "unavailable" : report.github.snapshotStatus === "stale" ? "saved snapshot is over 24 hours old" : "saved snapshot is within 24 hours"}</p>
        {report.github.lastSyncedAt && <p className="mt-1">Last saved: {new Date(report.github.lastSyncedAt).toLocaleString()}</p>}
        {report.github.reason && <p className="mt-1">{report.github.reason}</p>}
        <p className="mt-1">{report.github.refreshAvailable ? "An owner or admin can refresh the repository manually." : "Live refresh is unavailable."} <Link href={`/workspaces/${workspaceId}/repository`} className="font-semibold underline">Repository details</Link></p>
      </div>
      <p className="mt-4 text-sm text-slate-600">{report.taskCounts.unfinished} unfinished of {report.taskCounts.total} tasks · {report.taskCounts.unassigned} unassigned</p>
      {report.findings.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">
        {report.taskCounts.total === 0 && report.github.snapshotStatus === "unavailable" ? "No tasks or GitHub snapshot are available to assess yet." :
          report.github.snapshotStatus === "unavailable" ? "No task findings. GitHub data is unavailable, so repository health cannot be assessed." :
          report.github.snapshotStatus === "stale" ? report.github.refreshAvailable ?
            "No findings in available data. The GitHub snapshot is stale; refresh it before relying on repository results." :
            "No findings in available data. The GitHub snapshot is stale, and live refresh is unavailable." :
          "No findings in the available task and saved GitHub data."}
      </p> : <ul className="mt-4 grid gap-4 lg:grid-cols-2">{report.findings.map((finding) => <li key={finding.id} className={`rounded-xl border p-4 ${finding.severity === "CRITICAL" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
        <p className={`text-xs font-bold uppercase tracking-wide ${finding.severity === "CRITICAL" ? "text-rose-700" : "text-amber-800"}`}>{finding.severity.toLowerCase()}</p>
        <h3 className="mt-1 font-semibold text-slate-900">{finding.title}</h3>
        <p className="mt-2 text-sm text-slate-700">{finding.explanation}</p>
        <dl className="mt-3 space-y-1 text-xs text-slate-600">{finding.evidence.map((item) => <div key={item.label} className="flex flex-wrap gap-x-2"><dt className="font-semibold">{item.label}:</dt><dd className="break-all">{item.value}</dd></div>)}</dl>
        <p className="mt-3 text-sm font-medium text-slate-800">Next: {finding.suggestedAction}</p>
      </li>)}</ul>}
      <p className="mt-4 text-xs text-slate-500">Calculated {new Date(report.evaluatedAt).toLocaleString()} · Due dates use {report.workspaceTimeZone}. Signals indicate where to investigate; they do not measure task effort or actual review decisions.</p>
    </>}
  </section>;
}

export function HealthPanel({ workspaceId, refreshKey }: { workspaceId: string; refreshKey: number }) {
  const router = useRouter();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    apiRequest<HealthReport>(`/api/v1/workspaces/${workspaceId}/health`).then((value) => {
      if (!cancelled) { setReport(value); setError(""); }
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Request failed");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey, router]);
  return <HealthPanelView report={report} loading={loading} error={error} workspaceId={workspaceId} />;
}
