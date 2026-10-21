export function invitationStatusPresentation(status: string): { label: string; className: string } {
  switch (status) {
    case "PENDING": return { label: "Pending", className: "border-blue-200 bg-blue-50 text-blue-800" };
    case "ACCEPTED": return { label: "Accepted", className: "border-emerald-200 bg-emerald-50 text-emerald-800" };
    case "EXPIRED": return { label: "Expired", className: "border-amber-200 bg-amber-50 text-amber-900" };
    case "REVOKED": return { label: "Revoked", className: "border-rose-200 bg-rose-50 text-rose-800" };
    case "REJECTED": return { label: "Rejected", className: "border-slate-200 bg-slate-100 text-slate-700" };
    default: return { label: "Unknown status", className: "border-slate-200 bg-slate-100 text-slate-700" };
  }
}
