# Patchwork architecture

Patchwork is an npm-workspace modular monolith. `apps/web` renders the UI, `apps/api` owns authentication and all database-facing endpoints, `packages/contracts` shares request validation, and `packages/db` owns the Prisma schema, migrations, and PostgreSQL client factory.

```text
Browser (localhost:3000)
  ├─ Next.js pages
  └─ /auth/* and /api/* → Next.js rewrite → Express (localhost:4000)
                                      ├─ GitHub OAuth App: identity only
                                      ├─ GitHub App: read-only repository snapshots
                                      └─ Prisma 7 adapter-pg → PostgreSQL
```

The browser uses a single origin. Express stores a SHA-256 hash of each random opaque session token in PostgreSQL and sends the raw token only as a host-only, HttpOnly, SameSite=Lax cookie. Cookies are Secure under HTTPS. POST routes verify the request origin. GitHub OAuth uses a random state value, PKCE S256, and short-lived HttpOnly transaction cookies. The GitHub access token is used to retrieve the user's profile and is not persisted.

Workspace reads and writes are scoped by `WorkspaceMember` in the API service layer. A new workspace and its owner membership are created in one transaction. Task creation checks the actor's role and confirms any assignee is a member of the same workspace. All requests are validated against shared Zod contracts.

The first migration contains `User`, `Session`, `Workspace`, `WorkspaceMember`, and `Task`. A second additive migration stores one GitHub repository connection per workspace, issue/PR snapshots, and issue-event activity. The third adds reversible disconnect state, snapshot generations, and verified task-to-GitHub links. Tasks remain native to Patchwork. Project-health findings are calculated from existing data on each request without a new table or migration. Background sync and notifications are later milestones.

Repository connection has a separate GitHub App user authorization flow. The callback verifies the Patchwork session, OAuth state, GitHub user ID, and repository access before saving the connection. The user access token is discarded. Manual refresh mints a short-lived installation token restricted to the selected repository, then updates metadata, issue/PR snapshots, and timeline events in a transaction. Every API read checks workspace membership; connecting, disconnecting, and refreshing require OWNER or ADMIN. Disconnect and unlink actions set timestamps rather than deleting records. Each successful refresh or reconnection advances the active snapshot generation in the same transaction as its data writes. Records absent from the new snapshot remain stored but are excluded from active reads; returning GitHub IDs update their existing rows. Active task links follow the current generation, so links from a different previously connected repository remain stored without appearing as current links.

Prisma 7 loads the database URL through `packages/db/prisma.config.ts`, generates a client into an ignored directory, and uses `@prisma/adapter-pg` at runtime. Development and test use separate PostgreSQL databases. The API test runner checks both URLs and the databases they actually reach before running tests that write data.
