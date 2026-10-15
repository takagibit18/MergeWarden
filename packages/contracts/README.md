# Workbench API contracts

This package defines the browser-safe DTOs and runtime schemas shared by the
React workbench and its HTTP adapter. It contains no Node, database, Pi, or model
provider implementation.

`src/types.ts` and `src/constants.ts` are dependency-free. The core application
imports the type declarations with `import type` and the shared status, scope and
severity vocabularies from `constants.ts`, so the core test suite does not need Zod
at runtime. The Zod schemas build their enums from the same constants. Transport
adapters import the built `@mergewarden/contracts` package to validate requests
and public responses. Responses reject undeclared fields; callers must map native
records into DTOs rather than serialize manifests or database rows directly.

## Read API

All routes require the local workbench session established by its launcher.

| Method and path | Input | Response |
|---|---|---|
| `GET /api/v1/config` | No query parameters | `ConfigResponse` |
| `GET /api/v1/projects` | No query parameters | `ProjectsResponse` |
| `POST /api/v1/projects` | `RegisterProjectInput` body | `ProjectDto` |
| `POST /api/v1/projects/:projectId/workspaces` | `RegisterWorkspaceInput` body | `ProjectDto` |
| `GET /api/v1/projects/:projectId/reviews` | `workspaceId`, `status`, `scope`, `limit`, `cursor` | `HistoryResponse` |
| `GET /api/v1/projects/:projectId/tasks/:id` | Task or run UUID | `TaskResponse` |
| `GET /api/v1/projects/:projectId/runs/:id/report` | Run UUID | `ReportResponse` |
| `GET /api/v1/projects/:projectId/runs/:id/findings/:findingId/evidence/:index` | Run UUID, encoded finding ID, evidence index | `EvidenceResponse` |
| `GET /api/v1/projects/:projectId/runs/:id/findings/:findingId/evidence/:index/diff` | `offset`, `limit` (at most 200) | `EvidenceDiffResponse` |

Every review read is scoped to a project. `ConfigResponse.defaultProjectId` names
the project registered for the repository the host launched with.

History defaults to 20 rows and allows at most 50. A cursor belongs to its
repository and filter; changing either requires starting again without a cursor.
The repository and state directory come from the host, never the browser.

Use `encodeFindingId` for the finding path segment and `decodeFindingId` at the
HTTP boundary before validating parameters. The segment is `f_` followed by
unpadded base64url of the UTF-8 JSON string. This preserves native IDs containing
slashes, percent signs, Unicode, and dot segments during browser URL handling.
DTOs always retain the original finding ID.

`HistoryItem.title` is present only when it comes from the first line of a verified
report summary. Otherwise clients format their own fallback from scope and time.

History entries are projections refreshed in bounded batches. `sync.truncated`
means another refresh is needed to continue scanning. A projected
`reportAvailability: verified` records a previous successful verification;
report and evidence endpoints always verify their native artifacts again.
`status: null` means the native record cannot currently be verified.

`deliveryVerified: true` applies to delivery of a report, including partial,
failed, or cancelled reports. Only a verified report whose status is `completed`
confirms review completion. `canCancel` and all mutation capabilities are `false`
in this version.

Errors use `{ error: { code, message, traceId, fieldErrors? } }`. Validation errors
are 400, missing or foreign repository IDs are 404, unavailable or inconsistent
artifacts are 409, and unavailable local storage is 503. Request details, session
credentials, and provider configuration must not appear in public errors.

## Build

From the repository root:

```sh
npm run setup
npm run build:contracts
npm run test:contracts
```

`setup` installs locked dependencies with lifecycle scripts disabled and builds
this package before adapters run. After changing a contract, rebuild it before
checking either consumer; `npm run verify` enforces this order.
