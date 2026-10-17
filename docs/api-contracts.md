# Milestone 1 API contracts

The browser sends credentials to same-origin `/auth/*` and `/api/v1/*` paths. JSON successes use `{ "data": ... }`. JSON failures use `{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Method and path | Request | Response | Access |
| --- | --- | --- | --- |
| `GET /auth/github/start` | None | Redirect to GitHub | Public |
| `GET /auth/github/callback` | GitHub `code` and `state` | Session cookie and redirect to `/workspaces` | Public, valid OAuth transaction required |
| `POST /auth/logout` | None | `{ data: { signedOut: true } }` | Signed in, same origin |
| `GET /api/v1/me` | None | Current user's ID, GitHub login, name, avatar | Signed in |
| `GET /api/v1/workspaces` | None | Array of caller's workspaces with role | Signed in |
| `POST /api/v1/workspaces` | `name`, `slug`, optional IANA `timeZone` | Workspace with owner role, HTTP 201 | Signed in, same origin |
| `GET /api/v1/workspaces/:workspaceId/members` | None | Member IDs, login, names, and roles | Workspace member |
| `GET /api/v1/workspaces/:workspaceId/tasks` | Optional `cursor` | `{ items, nextCursor }`, at most 20 items | Workspace member |
| `POST /api/v1/workspaces/:workspaceId/tasks` | `title`, optional `description`, `status`, `priority`, `dueDate` (`YYYY-MM-DD`), `assigneeId` | Task, HTTP 201 | Owner, admin, or member; same origin |
| `PATCH /api/v1/workspaces/:workspaceId/tasks/:taskId` | At least one of `title`, `description`, `status`, `priority`, `dueDate`, `assigneeId`; the last two accept `null` to clear | Updated task | Owner, admin, or member; same origin and matching workspace |
| `GET /api/v1/workspaces/:workspaceId/github-links` | None | Verified active task links and safe GitHub item metadata | Workspace member |
| `POST /api/v1/workspaces/:workspaceId/tasks/:taskId/github-links` | `itemId` from the connected repository snapshot | Link, HTTP 201 | Owner, admin, or member; same origin; task and item must match workspace |
| `POST /api/v1/workspaces/:workspaceId/tasks/:taskId/github-links/:linkId/unlink` | None | `{ unlinked: true }`; the link is retained as history | Owner, admin, or member; same origin |

Task statuses: `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`. Priorities: `LOW`, `MEDIUM`, `HIGH`, `URGENT`. Task due dates are stored as PostgreSQL `DATE` and returned as `YYYY-MM-DD`.

An absent, invalid, expired, or revoked session gets HTTP 401. A viewer write gets 403. Nonmembership gets 404, including when a caller guesses a workspace ID. Invalid request bodies get 400. A duplicate workspace slug gets 409. An assignee outside the workspace gets 400. Secrets and internal error details are never returned to the browser.

## GitHub repository integration

| Method and path | Request | Response | Access |
| --- | --- | --- | --- |
| `POST /auth/github-app/start` | JSON: `workspaceId` UUID and `repository` as `owner/name` | Authorization URL and short-lived transaction cookie | Signed-in owner/admin; same origin; no active connection |
| `GET /auth/github-app/callback` | GitHub `code` and `state`, matching 10-minute transaction cookie and session | Connect repository, save first snapshot, redirect to repository page | Same signed-in owner/admin and verified GitHub account/repository access |
| `GET /api/v1/workspaces/:workspaceId/repository` | None | Configuration status, safe connection metadata, recent issues/PRs and activities | Workspace member |
| `GET /api/v1/workspaces/:workspaceId/repository/items` | `kind=ISSUE` or `PULL_REQUEST`, optional `cursor` | Up to 30 items and `nextCursor` | Workspace member |
| `GET /api/v1/workspaces/:workspaceId/repository/activity` | Optional `cursor` | Up to 50 events and `nextCursor` | Workspace member |
| `POST /api/v1/workspaces/:workspaceId/repository/refresh` | None | Updated snapshot | Owner/admin; same origin |
| `POST /api/v1/workspaces/:workspaceId/repository/disconnect` | None | Disconnected connection and retained cached snapshot | Owner/admin; same origin |

The GitHub App user token is used only during connection to check the GitHub account and its accessible installations/repositories. Refresh generates a repository-scoped installation token on the server. Neither token is persisted or returned. Missing configuration returns `GITHUB_NOT_CONFIGURED` (503) only after workspace authorization; primary and secondary rate limits return `GITHUB_RATE_LIMITED` (503) with safe retry guidance; revoked access, permission failures, and GitHub outages have distinct sanitized errors. A failed refresh keeps the previous active snapshot and records a safe status message. A successful refresh advances the active generation, so items and events absent from its response stop appearing in active reads without deleting their rows. GitHub pages are fetched until GitHub provides no next link; if more than 20 pages exist for a resource, refresh fails explicitly with `GITHUB_RESULT_LIMIT` and retains the previous snapshot.

## Project health

`GET /api/v1/workspaces/:workspaceId/health` is available to every authenticated workspace member, including viewers. Nonmembers receive 404. The endpoint reads stored tasks, member assignments, and the current GitHub snapshot; it never calls GitHub or changes data.

The response contains `evaluatedAt`, `workspaceTimeZone`, task counts, GitHub snapshot status (`unavailable`, `fresh`, or `stale`), last sync time, live refresh availability, and findings. Each finding has a deterministic rule ID, severity, explanation, evidence, and suggested action. The rules are: unfinished tasks past their due calendar date in the workspace time zone; open PRs that had no update for at least seven days **at the time of the saved snapshot**; `IN_REVIEW` tasks with no task update for at least three days; and a substantial spread of assigned unfinished task counts among members. Critical thresholds are three overdue days, fourteen idle PR days at snapshot time, seven review-stage idle days, or at least six tasks assigned to one member with a gap of five or more. The saved GitHub snapshot is labeled stale after 24 hours.

The task model does not record the moment a task entered review, reviewer requests, review decisions, task effort, or member capacity. Review-stage findings therefore describe task inactivity, and workload findings describe counts only. An unavailable GitHub snapshot produces no PR findings and is never presented as evidence that repository work is healthy. A stale snapshot can still produce findings, but the report marks its age and advises checking the live repository.
