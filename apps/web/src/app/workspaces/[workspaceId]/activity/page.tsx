"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { WorkspaceActivityItem, WorkspaceActivityPage } from "@patchwork/contracts";
import { apiRequest, ApiRequestError } from "@/lib/api";
import { ActivityTimelineView } from "./ActivityTimeline";

export default function ActivityPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const [page, setPage] = useState<WorkspaceActivityPage | null>(null);
  const [items, setItems] = useState<WorkspaceActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [olderError, setOlderError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError(""); setOlderError("");
    try {
      const result = await apiRequest<WorkspaceActivityPage>(`/api/v1/workspaces/${workspaceId}/activity`);
      setPage(result); setItems(result.items);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else setError(reason instanceof Error ? reason.message : "Request failed");
    } finally { setLoading(false); }
  }, [workspaceId, router]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadMore() {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true); setOlderError("");
    try {
      const result = await apiRequest<WorkspaceActivityPage>(`/api/v1/workspaces/${workspaceId}/activity?cursor=${encodeURIComponent(page.nextCursor)}`);
      setItems((previous) => [...previous, ...result.items]); setPage(result);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) router.replace("/login");
      else if (reason instanceof ApiRequestError && reason.status === 409) {
        setOlderError("The repository snapshot changed. Refresh the timeline to start again.");
        setPage((current) => current ? { ...current, nextCursor: null } : current);
      } else setOlderError(reason instanceof Error ? reason.message : "Request failed");
    } finally { setLoadingMore(false); }
  }

  return <ActivityTimelineView workspaceId={workspaceId} page={page} items={items} loading={loading} error={error}
    loadingMore={loadingMore} olderError={olderError} onRefresh={() => void refresh()} onLoadMore={() => void loadMore()} />;
}
