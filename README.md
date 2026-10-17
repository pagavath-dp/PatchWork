# Patchwork

Patchwork connects a small team's planned tasks to engineering activity. It has GitHub login, isolated workspaces, persistent tasks, a Kanban board, a read-only GitHub repository view with manual refresh, and explainable project-health findings.

## Prerequisites

- Node.js 24.13.0 and npm 11 (use `.nvmrc`)
- Docker Desktop with Docker Compose, or an equivalent local PostgreSQL 17 instance
- A GitHub OAuth App for sign-in only (see below)
- A separate GitHub App for repository integration (see below)

## Local setup

1. Copy `.env.example` to `.env`. Choose a local database password and use the same value in `POSTGRES_PASSWORD`, `DATABASE_URL`, and `TEST_DATABASE_URL`. Keep `.env` private.
2. Run `npm install` from the repository root.
3. Run `npm run db:up`. Wait until PostgreSQL is healthy.
4. Create the separate test database once: `docker compose exec db createdb -U patchwork patchwork_test`. If you changed `POSTGRES_USER`, use that value instead.
5. Run `npm run db:migrate`, `npm run db:migrate:test`, and `npm run db:generate`.
6. Run `npm run dev`, then open `http://localhost:3000`.

The test database must be distinct from the development database. The test runner checks this before running database integration tests.
Prisma migrations are committed under `packages/db/prisma/migrations`. For a future schema change, validate the schema first, then run `npm run db:migrate` and give the migration a descriptive name when prompted. The test migration command refuses a database name that matches development or does not end in `_test`.

## GitHub login setup

Create a **GitHub OAuth App** under GitHub Developer settings. For local development, set its homepage URL to `http://localhost:3000` and authorization callback URL to `http://localhost:3000/auth/github/callback`. Put its client ID and client secret in `.env`. Sign-in requests only profile access and does not request repository scopes.

## GitHub repository setup

Create a **separate GitHub App** with homepage `http://localhost:3000` and user authorization callback `http://localhost:3000/auth/github-app/callback`. Grant repository permissions **Metadata: read**, **Issues: read**, and **Pull requests: read**. Disable webhooks and leave “Request user authorization (OAuth) during installation” off. Generate a private key, store it outside this repository, and put its absolute path in `GITHUB_APP_PRIVATE_KEY_PATH` in your ignored `.env`. Also set `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` there. Never paste credentials into source files or issue reports.

Install the app on the specific repository to connect. Restart the API server after changing `.env`. In Patchwork, open the workspace's Repository page, enter `owner/repository`, and choose **Connect with GitHub**. The signed-in Patchwork user must authorize the GitHub App with the same GitHub account and have access to the repository. The server verifies this with a short-lived GitHub App user token, then discards that token. Manual refresh uses a repository-scoped installation token; neither token is stored or sent to the browser. One repository is active per workspace. Owners and admins can disconnect and reauthorize without deleting saved history.

The page shows saved issue, pull request, and issue-event snapshots with controls to load older records. A successful refresh publishes only the items and events returned by that complete refresh; a failed refresh leaves the previous active snapshot in place. A refresh that exceeds the 20-page per-resource safety limit reports an error rather than silently omitting records. Tasks can be assigned to workspace members, given due dates, and linked to verified issues or pull requests from the connected repository.

Reconnection keeps older snapshot rows and task-link records in PostgreSQL. The repository view and active task-link list show only records from the current successful snapshot, so links to a previous repository are not presented as current links. The schema updates a returning GitHub item or event in place, so it does not retain a complete version of every past snapshot. The current activity timeline contains GitHub issue/PR events only; a combined task-and-repository timeline and commit feed are not implemented. Webhooks and scheduled synchronization are also deferred.

## Checks

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

The API integration tests use `patchwork_test` and create unique test records without clearing database rows. They refuse to run if the test URL points to the development database. A GitHub OAuth App and GitHub App with real credentials are required for live browser checks; automated tests use mock GitHub responses. `npm run test:unit -w @patchwork/api` runs GitHub API, snapshot-service, and health-rule tests without PostgreSQL.

See `docs/architecture.md` and `docs/api-contracts.md` for the current design and endpoint contracts.

Do not commit `.env` or any real credential. `main` is the integration branch; use small feature branches and review changes before committing or merging.
The web app uses Next.js's supported Webpack mode for local development and builds because Turbopack's CSS worker could not bind a local port in the current environment.
