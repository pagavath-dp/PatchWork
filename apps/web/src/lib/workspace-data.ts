import { apiRequest, type Task, type Workspace } from "./api";

export type Member = { id: string; githubLogin: string; name: string | null; role: Workspace["role"] };
export type GitHubItem = { id: string; kind: "ISSUE" | "PULL_REQUEST"; number: number; title: string; htmlUrl: string };
export type TaskLink = { id: string; taskId: string; item: GitHubItem };
export type RepositoryItems = {
  repository: {
    issues: GitHubItem[];
    pulls: GitHubItem[];
    issuesNextCursor: string | null;
    pullsNextCursor: string | null;
  } | null;
};

type Request = typeof apiRequest;

export function loadWorkspaceSections(workspaceId: string, request: Request = apiRequest) {
  return {
    core: Promise.all([
      request<Workspace[]>("/api/v1/workspaces"),
      request<{ items: Task[]; nextCursor: string | null }>(`/api/v1/workspaces/${workspaceId}/tasks`),
    ]),
    members: request<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    links: request<TaskLink[]>(`/api/v1/workspaces/${workspaceId}/github-links`),
    repository: request<RepositoryItems>(`/api/v1/workspaces/${workspaceId}/repository`),
  };
}
