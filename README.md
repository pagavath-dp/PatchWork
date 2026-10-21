# Patchwork

Patchwork connects a small team's planned tasks to engineering activity. It has GitHub sign-in, shared workspaces with invitations and roles, persistent tasks and a Kanban board, a combined team timeline, read-only GitHub repository snapshots with manual refresh, and explainable project-health findings.

## Stack and repository

This is an npm-workspace project. `apps/web` is a Next.js 16, React 19, TypeScript, Tailwind CSS 4 interface; `apps/api` is an Express 5 and TypeScript server. `packages/contracts` holds shared Zod validation and API types. `packages/db` holds Prisma 7, its PostgreSQL driver adapter, schema, client factory, and migrations. `docs/` contains the architecture and API reference. GitHub login and repository access use separate OAuth App and GitHub App flows.

## Prerequisites

- Node.js 24.13.0 and a compatible npm version (use `.nvmrc`)
- Docker Desktop with Docker Compose, or an equivalent local PostgreSQL 17 instance
- A GitHub OAuth App for sign-in only (see below)
- A separate GitHub App for repository integration (see below)

## Local setup

1. Copy `.env.example` to `.env`. Choose a local database password and use the same value in `POSTGRES_PASSWORD`, `DATABASE_URL`, and `TEST_DATABASE_URL`. Keep `.env` private.
2. Run `npm install` from the repository root.
3. Run `npm run db:up`. Wait until PostgreSQL is healthy.
4. Create the separate test database once: `docker compose exec db createdb -U patchwork patchwork_test`. If you changed `POSTGRES_USER`, use that value instead.
5. Run `npm run db:migrate`, `npm run db:migrate:test`, and `npm run db:generate`.
6. Run `npm run dev`, then open `http://localhost:3000`. Next.js serves the UI on port 3000 and rewrites `/auth/*` and `/api/*` to Express on port 4000. `API_INTERNAL_ORIGIN` can override that internal API address when needed.

For separate development terminals, run `npm run dev -w @patchwork/api` and `npm run dev -w @patchwork/web`. The API loads the root `.env` file; restart it after changing local configuration.

The template in `.env.example` names the required local variables. `APP_ORIGIN` and `GITHUB_OAUTH_CALLBACK_URL` must have the same origin. `API_PORT` sets the Express port; `POSTGRES_HOST_PORT` sets the localhost Docker port. Keep real values in the ignored `.env` file. The GitHub App variables are optional until repository connection is needed; GitHub OAuth credentials are required to start the API.

The test database must be distinct from the development database. The integration test runner checks the configured URLs and the databases they reach before writing test records. `npm test` includes that database-writing suite; use the narrower commands below when database tests are not intended.
Prisma migrations are committed under `packages/db/prisma/migrations`. For a future schema change, validate the schema first, then run `npm run db:migrate` and give the migration a descriptive name when prompted. The test migration command refuses a database name that matches development or does not end in `_test`.

## GitHub login setup

Create a **GitHub OAuth App** under GitHub Developer settings. For local development, set its homepage URL to `http://localhost:3000` and authorization callback URL to `http://localhost:3000/auth/github/callback`. Put its client ID and client secret in `.env`. Sign-in requests only profile access and does not request repository scopes.

## Workspace invitations and roles

An owner or admin opens **Members and invitations** from a workspace and enters a teammate's GitHub username. Patchwork verifies the username through GitHub's public user API and binds the invitation to the account's immutable GitHub ID. The inviter shares the one-time displayed link privately. The recipient signs in with that GitHub account **before** opening the link, then accepts or declines it. Invitations expire after seven days; the server stores only a hash of the link token. GitHub's public lookup can be rate-limited, in which case invitation creation reports a retryable error.

Owners may invite admins, members, or viewers and may change any member's role. Admins may invite members or viewers and manage those roles, but cannot promote themselves or change owners or other admins. Members can edit tasks and links; viewers read workspace data only. Members and admins may leave; an owner may leave or be demoted only when another owner remains. Assigned tasks must be reassigned before removing their assignee. Pending invitations are revoked when their inviter leaves or loses the permission to grant the invited role. The workspace's legacy owner reference follows an owner who remains when its referenced owner leaves or is demoted.

## GitHub repository setup

Create a **separate GitHub App** with homepage `http://localhost:3000` and user authorization callback `http://localhost:3000/auth/github-app/callback`. Grant repository permissions **Metadata: read**, **Issues: read**, and **Pull requests: read**. Disable webhooks and leave “Request user authorization (OAuth) during installation” off. Generate a private key, store it outside this repository, and put its absolute path in `GITHUB_APP_PRIVATE_KEY_PATH` in your ignored `.env`. Also set `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` there. Never paste credentials into source files or issue reports.

Install the app on the specific repository to connect. Restart the API server after changing `.env`. In Patchwork, open the workspace's Repository page, enter `owner/repository`, and choose **Connect with GitHub**. The signed-in Patchwork user must authorize the GitHub App with the same GitHub account and have access to the repository. The server verifies this with a short-lived GitHub App user token, then discards that token. Manual refresh uses a repository-scoped installation token; neither token is stored or sent to the browser. One repository is active per workspace. Owners and admins can disconnect and reauthorize without deleting saved history.

The page shows saved issue, pull request, and issue-event snapshots with controls to load older records. A successful refresh publishes only the items and events returned by that complete refresh; a failed refresh leaves the previous active snapshot in place. A refresh that exceeds the 20-page per-resource safety limit reports an error rather than silently omitting records. Tasks can be assigned to workspace members, given due dates, and linked to verified issues or pull requests from the connected repository.

Reconnection keeps older snapshot rows and task-link records in PostgreSQL. The repository view and active task-link list show only records from the current successful snapshot, so links to a previous repository are not presented as current links. The schema updates a returning GitHub item or event in place, so it does not retain a complete version of every past snapshot. The **Team timeline** combines recorded task changes and current-generation GitHub issue/PR activity; historical task link/unlink events remain visible after reconnection. Existing tasks were not backfilled with activity. A commit feed, webhooks, scheduled synchronization, notifications, and AI summaries are not implemented.

## Checks

- `npm run lint`
- `npm run typecheck`
- `npm test` (includes PostgreSQL-writing API integration tests)
- `npm run build`
- `npm run db:deploy` (apply pending migrations to `DATABASE_URL`; verify the target before use)
- `npm run db:migrate:test` (apply migrations to `TEST_DATABASE_URL` after its safety checks)
- `npm run db:generate` (generate the Prisma client)
- `npm run test:unit -w @patchwork/api` (database-independent API unit tests)
- `npm run test -w @patchwork/web` and `npm run test -w @patchwork/contracts` (database-independent UI and contract tests)

The API integration tests use `patchwork_test` and create unique test records without clearing database rows. They refuse to run if the test URL points to the development database. Database-backed repository race behavior still needs a successful verification run. Automated GitHub tests use mock responses. Live GitHub App connection, refresh, and failure recovery require manual verification with a configured installation.

## Current limits and submission work

Tasks have create, list, edit, assignment, and status moves, but no delete or archive action. The task list and repository snapshots have bounded cursor pagination; invitations show the 100 most recent records. Invitation links are copied and shared manually. Repository activity covers GitHub issue/PR events, not commits. The health engine uses saved snapshots and task fields; it cannot infer actual reviewer decisions, task effort, or individual capacity.

This repository has a local Docker Compose PostgreSQL setup but no checked-in production deployment configuration or hosting-specific deployment command. Before course submission, choose hosting for the web app, API, and PostgreSQL; configure HTTPS origins, both callback URLs, persistent database storage, and server-only secrets; then verify both GitHub flows on that origin. Prepare the required screenshots, GitHub source link, and two-person work division in the report. Do not treat a passing unit test as a live integration check.

See `docs/architecture.md` and `docs/api-contracts.md` for the current design and endpoint contracts.

Do not commit `.env` or any real credential. `main` is the integration branch; use small feature branches and review changes before committing or merging. The web app uses Next.js's supported Webpack mode for local development and builds.
