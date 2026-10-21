import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceActivityPage } from "@patchwork/contracts";
import { ActivityTimelineView } from "./ActivityTimeline";

const page: WorkspaceActivityPage = {
  items: [], nextCursor: null,
  github: { snapshotStatus: "unavailable", lastSyncedAt: null, refreshAvailable: false,
    reason: "No repository is connected" },
};

function render(overrides: Partial<Parameters<typeof ActivityTimelineView>[0]> = {}) {
  return renderToStaticMarkup(<ActivityTimelineView workspaceId="workspace-1" page={page} items={[]}
    loading={false} error="" loadingMore={false} olderError="" onRefresh={() => {}} onLoadMore={() => {}} {...overrides} />);
}

describe("combined activity timeline", () => {
  it("keeps loading, error, and empty states distinct from GitHub availability", () => {
    expect(render({ page: null, loading: true })).toContain("Loading activity");
    expect(render({ page: null, error: "Service unavailable" })).toContain("Could not load activity: Service unavailable");
    const empty = render();
    expect(empty).toContain("GitHub snapshot: unavailable");
    expect(empty).toContain("Task activity remains available independently");
    expect(empty).toContain("No recorded activity yet");
  });

  it("shows task and GitHub records, stale snapshot context, and older-page errors", () => {
    const items: WorkspaceActivityPage["items"] = [
      { id: "task-1", source: "TASK", occurredAt: "2026-10-19T12:00:00.000Z", actorId: "user-1",
        actorLogin: "teammate", taskId: "task-1", taskTitle: "Prepare demo", kind: "TASK_UPDATED",
        details: { changes: [{ field: "status", before: "TODO", after: "DONE" }] } },
      { id: "github-1", source: "GITHUB", occurredAt: "2026-10-19T11:00:00.000Z", actorLogin: "reviewer",
        event: "opened", itemNumber: 4, itemTitle: "Review work", itemUrl: "javascript:alert(1)" },
    ];
    const html = render({ items, page: { items, nextCursor: "cursor",
      github: { snapshotStatus: "stale", lastSyncedAt: "2026-10-17T11:00:00.000Z", refreshAvailable: false,
        reason: "The saved GitHub snapshot is over 24 hours old" } }, olderError: "Try again" });
    expect(html).toContain("GitHub snapshot: stale");
    expect(html).toContain("@teammate");
    expect(html).toContain("Prepare demo");
    expect(html).toContain("Changed: status");
    expect(html).toContain("#4 Review work");
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("Could not load older activity: Try again");
    expect(html).toContain("Load older activity");
  });
});
