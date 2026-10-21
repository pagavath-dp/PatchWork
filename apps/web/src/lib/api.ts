export type Workspace = {
  id: string;
  name: string;
  slug: string;
  timeZone: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
};

export type Task = {
  id: string;
  revision: string;
  title: string;
  description: string | null;
  status: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: string | null;
  assigneeId: string | null;
};

export class ApiRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options?.body ? { "Content-Type": "application/json" } : {}), ...options?.headers },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok) throw new ApiRequestError(response.status, body?.error?.message ?? "Request failed");
  if (body?.data === undefined) throw new ApiRequestError(response.status, "Unexpected response");
  return body.data;
}
