import { z } from 'zod/v4';
import { REPORT_STATUSES, REVIEW_SCOPES, REVIEW_STATUSES, SEVERITIES } from './constants.js';
import type {
  ConfigResponse, ErrorResponse, EvidenceRefDto, EvidenceResponse, FindingDto,
  HistoryItem, HistoryResponse, ReportDto, ReportResponse, SnapshotIdentityDto,
  SourcePageDto, TaskResponse, WorkspaceDto, ProjectDto, ProjectsResponse,
  RegisterProjectInput, RegisterWorkspaceInput, DiffSideDto, DiffRowDto, FrozenDiffDto, EvidenceDiffResponse,
} from './types.js';

export const idSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewScopeSchema = z.enum(REVIEW_SCOPES);
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export const severitySchema = z.enum(SEVERITIES);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();

export const historyQuerySchema = z.object({
  workspaceId: sha256Schema.optional(),
  status: reviewStatusSchema.optional(),
  scope: reviewScopeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

export const historyItemSchema: z.ZodType<HistoryItem> = z.object({
  id: idSchema,
  taskId: idSchema.optional(),
  runId: idSchema.optional(),
  repositoryPath: z.string(),
  projectId: idSchema.optional(),
  workspaceId: sha256Schema.optional(),
  title: z.string().min(1).max(160).optional(),
  createdAt: timestamp,
  finishedAt: timestamp.optional(),
  status: reviewStatusSchema.nullable(),
  scope: reviewScopeSchema.nullable(),
  model: z.object({ provider: z.string(), modelId: z.string() }).strict().optional(),
  snapshotId: sha256Schema.optional(),
  findingCount: count.optional(),
  reportAvailability: z.enum(['verified', 'not_delivered', 'unavailable']),
  liveness: z.enum(['unknown', 'owner_present', 'owner_exited']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();

export const syncStatsSchema = z.object({
  lastSyncedAt: timestamp.nullable(), scanned: count, skipped: count, truncated: z.boolean(),
}).strict();
export const historyResponseSchema: z.ZodType<HistoryResponse> = z.object({
  projectId: idSchema.optional(),
  repositoryPath: z.string(), items: z.array(historyItemSchema), nextCursor: z.string().nullable(), sync: syncStatsSchema,
}).strict();
export const taskResponseSchema: z.ZodType<TaskResponse> = z.object({
  item: historyItemSchema, done: z.boolean(), canCancel: z.literal(false),
}).strict();
export const configResponseSchema: z.ZodType<ConfigResponse> = z.object({
  apiVersion: z.literal('v1'),
  defaultProjectId: idSchema,
  repository: z.object({ path: z.string(), name: z.string() }).strict(),
  capabilities: z.object({
    readHistory: z.literal(true), readReport: z.literal(true), readEvidence: z.literal(true),
    readDiff: z.literal(true), manageProjects: z.literal(true),
    startReview: z.literal(false), cancelReview: z.literal(false), feedback: z.literal(false), learning: z.literal(false),
  }).strict(),
  history: z.object({ defaultLimit: z.literal(20), maxLimit: z.literal(50) }).strict(),
}).strict();

const displayNameSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/);
const repositoryPathSchema = z.string().trim().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/);
export const workspaceSchema: z.ZodType<WorkspaceDto> = z.object({
  id: sha256Schema, name: displayNameSchema, path: repositoryPathSchema,
  kind: z.enum(['primary', 'worktree']), registeredAt: timestamp,
}).strict();
export const projectSchema: z.ZodType<ProjectDto> = z.object({
  id: idSchema, name: displayNameSchema, repositoryPath: repositoryPathSchema,
  createdAt: timestamp, workspaces: z.array(workspaceSchema).min(1).max(50),
}).strict().refine(project => {
  const primary = project.workspaces.filter(workspace => workspace.kind === 'primary');
  return primary.length === 1 && primary[0]?.path === project.repositoryPath &&
    new Set(project.workspaces.map(workspace => workspace.id)).size === project.workspaces.length &&
    new Set(project.workspaces.map(workspace => workspace.path)).size === project.workspaces.length;
}, { message: 'A project requires one primary directory and unique workspace identities' });
export const projectsResponseSchema: z.ZodType<ProjectsResponse> = z.object({
  defaultProjectId: idSchema, projects: z.array(projectSchema).min(1).max(50),
}).strict().refine(value => {
  const workspaces = value.projects.flatMap(project => project.workspaces);
  return value.projects.some(project => project.id === value.defaultProjectId) &&
    new Set(value.projects.map(project => project.id)).size === value.projects.length &&
    new Set(workspaces.map(workspace => workspace.id)).size === workspaces.length;
}, { message: 'Default project and workspace identities must belong to one catalog entry' });
export const projectRegistrationSchema: z.ZodType<RegisterProjectInput> = z.object({
  repositoryPath: repositoryPathSchema, name: displayNameSchema.optional(),
}).strict();
export const workspaceRegistrationSchema: z.ZodType<RegisterWorkspaceInput> = z.object({
  repositoryPath: repositoryPathSchema, name: displayNameSchema.optional(),
}).strict();

const versionSchema = z.object({ kind: z.enum(['commit', 'content', 'empty']), id: z.string() }).strict();
export const snapshotIdentitySchema: z.ZodType<SnapshotIdentityDto> = z.object({
  id: sha256Schema, repositoryId: z.string(), baseCommit: z.string().optional(), headCommit: z.string().optional(),
  baseVersion: versionSchema.optional(), headVersion: versionSchema.optional(),
  inputFingerprint: sha256Schema, configurationFingerprint: sha256Schema,
}).strict();
export const evidenceRefSchema: z.ZodType<EvidenceRefDto> = z.object({
  snapshotId: sha256Schema, revision: z.enum(['base', 'head']), path: z.string(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentSha256: sha256Schema,
}).strict().refine(value => value.endLine >= value.startLine, { message: 'End line must not precede start line' });
export const findingSchema: z.ZodType<FindingDto> = z.object({
  id: z.string(), title: z.string(), claim: z.string(), trigger: z.string(), impact: z.string(), severity: severitySchema,
  evidence: z.array(evidenceRefSchema),
}).strict();
export const reportSchema: z.ZodType<ReportDto> = z.object({
  schemaVersion: z.literal(1), runId: idSchema, snapshot: snapshotIdentitySchema,
  status: reportStatusSchema, summary: z.string(), findings: z.array(findingSchema),
  coverage: z.record(z.string(), z.enum(['pending', 'done', 'failed'])), publication: z.literal('not_requested'),
}).strict();
export const reportResponseSchema: z.ZodType<ReportResponse> = z.object({
  review: historyItemSchema, deliveryVerified: z.literal(true), report: reportSchema,
}).strict();
export const sourcePageSchema: z.ZodType<SourcePageDto> = z.object({
  snapshotId: sha256Schema, revision: z.enum(['base', 'head']), path: z.string(), status: z.enum(['ok', 'unavailable']),
  text: z.string(), startLine: count, endLine: count, totalLines: count, contentSha256: sha256Schema,
  truncated: z.boolean(), hasMoreLines: z.boolean().optional(), warnings: z.array(z.string()),
}).strict();
export const evidenceResponseSchema: z.ZodType<EvidenceResponse> = z.object({
  runId: idSchema, findingId: z.string(), evidenceIndex: count, evidenceCount: count,
  evidence: evidenceRefSchema, source: sourcePageSchema,
}).strict();

export const diffQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(2_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
}).strict();
export const diffSideSchema: z.ZodType<DiffSideDto> = z.object({
  exists: z.boolean(), contentSha256: sha256Schema.nullable(), totalLines: count,
  endsWithNewline: z.boolean().nullable(), mode: z.string().nullable(),
}).strict().refine(side => side.exists || (side.contentSha256 === null && side.totalLines === 0 && side.endsWithNewline === null && side.mode === null),
  { message: 'An absent side cannot contain source metadata' });
export const diffRowSchema: z.ZodType<DiffRowDto> = z.object({
  kind: z.enum(['context', 'addition', 'deletion', 'hunk']), text: z.string().max(16_384),
  baseLine: z.number().int().positive().nullable(), headLine: z.number().int().positive().nullable(),
  hunk: z.object({ baseStart: count, baseCount: count, headStart: count, headCount: count }).strict().optional(),
  noFinalNewline: z.boolean().optional(),
}).strict().refine(row => {
  if (row.kind === 'hunk') return row.hunk !== undefined && row.baseLine === null && row.headLine === null && row.noFinalNewline === undefined;
  if (row.hunk !== undefined) return false;
  if (row.kind === 'context') return row.baseLine !== null && row.headLine !== null;
  return row.kind === 'addition' ? row.baseLine === null && row.headLine !== null : row.baseLine !== null && row.headLine === null;
}, { message: 'Diff line numbers must match the row kind' });
export const frozenDiffSchema: z.ZodType<FrozenDiffDto> = z.object({
  snapshotId: sha256Schema, path: z.string(), status: z.enum(['ok', 'unavailable']),
  changeType: z.enum(['added', 'deleted', 'modified', 'unchanged']),
  base: diffSideSchema, head: diffSideSchema, rows: z.array(diffRowSchema).max(200),
  offset: count, totalRows: count, nextOffset: count.nullable(), truncated: z.boolean(), warnings: z.array(z.string()),
}).strict().refine(diff => {
  if (diff.status === 'unavailable') return diff.rows.length === 0 && diff.nextOffset === null && diff.warnings.length > 0;
  const next = diff.offset + diff.rows.length;
  return next <= diff.totalRows && (diff.nextOffset === null
    ? !diff.truncated && next === diff.totalRows
    : diff.truncated && diff.rows.length > 0 && diff.nextOffset === next && next < diff.totalRows);
}, { message: 'Diff pagination must make bounded forward progress' });
export const evidenceDiffResponseSchema: z.ZodType<EvidenceDiffResponse> = z.object({
  runId: idSchema, findingId: z.string(), evidenceIndex: count, evidenceCount: count,
  evidence: evidenceRefSchema, diff: frozenDiffSchema,
}).strict().refine(value => value.evidenceIndex < value.evidenceCount && value.evidence.snapshotId === value.diff.snapshotId && value.evidence.path === value.diff.path,
  { message: 'Diff must belong to the selected frozen evidence' });
export const errorResponseSchema: z.ZodType<ErrorResponse> = z.object({
  error: z.object({
    code: z.string(), message: z.string(), fieldErrors: z.record(z.string(), z.array(z.string())).optional(), traceId: z.string(),
  }).strict(),
}).strict();

export const taskParamsSchema = z.object({ id: idSchema }).strict();
export const projectParamsSchema = z.object({ projectId: idSchema }).strict();
export const scopedTaskParamsSchema = z.object({ projectId: idSchema, id: idSchema }).strict();
export const evidenceParamsSchema = z.object({
  id: idSchema, findingId: z.string().min(1).max(4000), index: z.coerce.number().int().min(0).max(19),
}).strict();
export const scopedEvidenceParamsSchema = evidenceParamsSchema.extend({ projectId: idSchema }).strict();
