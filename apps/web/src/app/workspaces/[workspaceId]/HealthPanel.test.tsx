import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HealthReport } from "@patchwork/contracts";
import { HealthPanelView } from "./HealthPanel";

const report: HealthReport = {
  evaluatedAt: "2026-10-17T12:00:00.000Z", workspaceTimeZone: "UTC",
  github: { snapshotStatus: "unavailable", lastSyncedAt: null, refreshAvailable: false,
    reason: "No GitHub repository is connected." },
  taskCounts: { total: 0, unfinished: 0, unassigned: 0 }, findings: [],
};
const render = (overrides: Partial<Parameters<typeof HealthPanelView>[0]> = {}) => renderToStaticMarkup(
  <HealthPanelView report={report} loading={false} error="" workspaceId="workspace-1" {...overrides} />,
);

describe("project health panel", () => {
  it("shows loading and localized errors", () => {
    expect(render({ report: null, loading: true })).toContain("Checking project health");
    expect(render({ report: null, error: "Service unavailable" })).toContain("Could not load project health: Service unavailable");
  });

  it("does not label missing GitHub data as healthy", () => {
    const html = render();
    expect(html).toContain("GitHub data: unavailable");
    expect(html).toContain("No tasks or GitHub snapshot are available to assess yet");
    expect(html).toContain("Live refresh is unavailable");
  });

  it("shows stale snapshot context and evidence for findings", () => {
    const html = render({ report: { ...report,
      github: { snapshotStatus: "stale", lastSyncedAt: "2026-10-14T12:00:00.000Z", refreshAvailable: false,
        reason: "GitHub App configuration is missing; live refresh is unavailable." },
      findings: [{ id: "pull:1", rule: "STALE_PULL_REQUEST", severity: "WARNING", title: "Stale open pull request #1",
        explanation: "No GitHub update for 7 days.", evidence: [{ label: "Last PR update", value: "2026-10-10" }],
        suggestedAction: "Check the pull request." }],
    } });
    expect(html).toContain("saved snapshot is over 24 hours old");
    expect(html).toContain("Stale open pull request #1");
    expect(html).toContain("warning");
    expect(html).toContain("No GitHub update for 7 days.");
    expect(html).toContain("Last PR update");
    expect(html).toContain("Next: Check the pull request.");
  });

  it("does not suggest an unavailable refresh when a stale snapshot has no findings", () => {
    const html = render({ report: { ...report, github: { snapshotStatus: "stale",
      lastSyncedAt: "2026-10-14T12:00:00.000Z", refreshAvailable: false,
      reason: "GitHub App configuration is missing; live refresh is unavailable." } } });
    expect(html).toContain("The GitHub snapshot is stale, and live refresh is unavailable.");
    expect(html).not.toContain("refresh it before relying");
  });
});
