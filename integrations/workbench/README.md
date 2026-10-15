# Local Workbench HTTP adapter

This Node.js 22.19+ foreground adapter provides the read-only M0/M1 Workbench.
It reuses `WorkbenchService`, the rebuildable SQLite history projection, native
delivery verification and frozen source evidence. It does not load Pi or require
model credentials.

From the repository root, install locked packages with lifecycle scripts disabled,
build the contracts and frontend, then start the adapter:

```sh
npm run setup
npm --prefix packages/contracts run build
npm --prefix apps/workbench run build
npm --prefix integrations/workbench start -- --repo /path/to/repository --state /outside/state --port 0
```

`--repo` is required. `--state` defaults to the existing `MergeWarden2` data
directory and must be outside the reviewed repository. `--port` defaults to `0`,
which selects an available port. The listener always binds `127.0.0.1`. It prints
the actual startup URL and stays in the foreground; Ctrl+C/SIGTERM closes the
listener, source scanner and SQLite handle.

Open the same printed URL in Codex's browser panel or an external browser. Its
fragment capability is removed from browser history before any resource/API
loads, then exchanged in a POST body for a process-local HttpOnly,
SameSite=Strict cookie. Requests, bodies and credentials are not logged. The app
and API share the actual loopback origin, and unexpected Host/Origin/fetch-site
headers are rejected. Reopening the URL with an existing cookie also removes the
fragment before frontend resources load.

The supported app/API development and integration workflow is **build + serve**.
Vite's asset/HMR development server does not provide authenticated API integration;
this adapter deliberately provides no API proxy or additional trusted origin.

The public API exposes these read routes:

| Route | Response |
| --- | --- |
| `GET /api/v1/config` | Fixed repository and read-only capability flags |
| `GET /api/v1/projects` | Registered project and directory metadata |
| `GET /api/v1/reviews?status=&scope=&workspaceId=&limit=&cursor=` | Default project's bounded history page and sync diagnostics |
| `GET /api/v1/projects/:projectId/reviews?...` | Project history, optionally filtered to a registered directory |
| `GET /api/v1/tasks/:id` | Native task/run status; cancellation is unavailable |
| `GET /api/v1/runs/:id/report` | Freshly verified delivery and public report DTO |
| `GET /api/v1/runs/:id/findings/:findingId/evidence/:index` | Verified frozen evidence and source |
| `GET /api/v1/runs/:id/findings/:findingId/evidence/:index/diff?offset=&limit=` | Bounded base/head diff from the frozen snapshot |
| `/api/v1/projects/:projectId/...` | Project-scoped versions of task, report, evidence and diff reads |

The app can explicitly register a project with `POST /api/v1/projects` and a same-repository worktree with `POST /api/v1/projects/:projectId/workspaces`. Both endpoints require the authenticated same-origin session and accept only an absolute Git root plus an optional display name. Registration does not scan or execute repository files. Review history, report, evidence and diff routes remain read-only; review start/cancel, feedback and learning routes are absent.

For the finding path segment, use `encodeFindingId(rawId)` from
`@mergewarden/contracts`; the adapter decodes and validates the opaque `f_`
JSON/base64url segment. This preserves Unicode, percent signs, slashes, dot-only
values and native UTF-16 IDs without URL normalization changing their identity.
The query/response schemas reject unknown configuration and secret-bearing fields.
Errors return `{error:{code,message,fieldErrors?,traceId}}` with fixed safe messages.

Compiled assets are served only from `apps/workbench/dist`. Static traversal,
directory links, source/config extensions and unknown file requests are rejected.
SPA fallback is limited to HTML navigation and never handles `/api` or internal
bootstrap routes. Missing frontend builds produce an explicit unavailable error.

```sh
npm --prefix integrations/workbench test
npm --prefix integrations/workbench run typecheck
```

Tests cover injection-level auth/path/DTO failures, registration, frozen diff,
and real HTTP, SQLite, native delivery artifacts and frozen snapshots. Model
responses/MemoryJournal in these fixtures are explicitly synthetic; these tests
make no model-quality claim.
