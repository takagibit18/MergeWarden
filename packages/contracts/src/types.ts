import type { REPORT_STATUSES, REVIEW_SCOPES, REVIEW_STATUSES, SEVERITIES } from './constants.js';

export type ReviewScope = typeof REVIEW_SCOPES[number];
export type ReviewStatus = typeof REVIEW_STATUSES[number];
export type ReportStatus = typeof REPORT_STATUSES[number];
export type Severity = typeof SEVERITIES[number];

export interface HistoryQuery {
  workspaceId?: string | undefined;
  status?: ReviewStatus | undefined;
  scope?: ReviewScope | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface HistoryItem {
  id: string;
  taskId?: string | undefined;
  runId?: string | undefined;
  repositoryPath: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  /** First line of the verified report summary. Absent when no verified summary exists; clients format a fallback. */
  title?: string | undefined;
  createdAt: string;
  finishedAt?: string | undefined;
  status: ReviewStatus | null;
  scope: ReviewScope | null;
  model?: { provider: string; modelId: string } | undefined;
  snapshotId?: string | undefined;
  findingCount?: number | undefined;
  reportAvailability: 'verified' | 'not_delivered' | 'unavailable';
  liveness?: 'unknown' | 'owner_present' | 'owner_exited' | undefined;
  error?: { code: string; message: string } | undefined;
}

export interface SyncStats {
  lastSyncedAt: string | null;
  scanned: number;
  skipped: number;
  truncated: boolean;
}

export interface HistoryResponse {
  projectId?: string | undefined;
  repositoryPath: string;
  items: HistoryItem[];
  nextCursor: string | null;
  sync: SyncStats;
}

export interface TaskResponse {
  item: HistoryItem;
  done: boolean;
  canCancel: false;
}

export interface ConfigResponse {
  apiVersion: 'v1';
  defaultProjectId: string;
  repository: { path: string; name: string };
  capabilities: {
    readHistory: true;
    readReport: true;
    readEvidence: true;
    readDiff: true;
    manageProjects: true;
    startReview: false;
    cancelReview: false;
    feedback: false;
    learning: false;
  };
  history: { defaultLimit: 20; maxLimit: 50 };
}

export interface WorkspaceDto {
  id: string;
  name: string;
  path: string;
  kind: 'primary' | 'worktree';
  registeredAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  repositoryPath: string;
  createdAt: string;
  workspaces: WorkspaceDto[];
}

export interface ProjectsResponse {
  defaultProjectId: string;
  projects: ProjectDto[];
}

export interface RegisterProjectInput {
  repositoryPath: string;
  name?: string | undefined;
}

export interface RegisterWorkspaceInput {
  repositoryPath: string;
  name?: string | undefined;
}

export interface SnapshotIdentityDto {
  id: string;
  repositoryId: string;
  baseCommit?: string | undefined;
  headCommit?: string | undefined;
  baseVersion?: { kind: 'commit' | 'content' | 'empty'; id: string } | undefined;
  headVersion?: { kind: 'commit' | 'content' | 'empty'; id: string } | undefined;
  inputFingerprint: string;
  configurationFingerprint: string;
}

export interface EvidenceRefDto {
  snapshotId: string;
  revision: 'base' | 'head';
  path: string;
  startLine: number;
  endLine: number;
  contentSha256: string;
}

export interface FindingDto {
  id: string;
  title: string;
  claim: string;
  trigger: string;
  impact: string;
  severity: Severity;
  evidence: EvidenceRefDto[];
}

export interface ReportDto {
  schemaVersion: 1;
  runId: string;
  snapshot: SnapshotIdentityDto;
  status: ReportStatus;
  summary: string;
  findings: FindingDto[];
  coverage: Record<string, 'pending' | 'done' | 'failed'>;
  publication: 'not_requested';
}

export interface ReportResponse {
  review: HistoryItem;
  deliveryVerified: true;
  report: ReportDto;
}

export interface SourcePageDto {
  snapshotId: string;
  revision: 'base' | 'head';
  path: string;
  status: 'ok' | 'unavailable';
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  contentSha256: string;
  truncated: boolean;
  hasMoreLines?: boolean | undefined;
  warnings: string[];
}

export interface EvidenceResponse {
  runId: string;
  findingId: string;
  evidenceIndex: number;
  evidenceCount: number;
  evidence: EvidenceRefDto;
  source: SourcePageDto;
}

export interface DiffQuery {
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface DiffSideDto {
  exists: boolean;
  contentSha256: string | null;
  totalLines: number;
  endsWithNewline: boolean | null;
  mode: string | null;
}

export interface DiffHunkHeaderDto {
  baseStart: number;
  baseCount: number;
  headStart: number;
  headCount: number;
}

export interface DiffRowDto {
  kind: 'context' | 'addition' | 'deletion' | 'hunk';
  text: string;
  baseLine: number | null;
  headLine: number | null;
  hunk?: DiffHunkHeaderDto | undefined;
  noFinalNewline?: boolean | undefined;
}

export interface FrozenDiffDto {
  snapshotId: string;
  path: string;
  status: 'ok' | 'unavailable';
  changeType: 'added' | 'deleted' | 'modified' | 'unchanged';
  base: DiffSideDto;
  head: DiffSideDto;
  rows: DiffRowDto[];
  offset: number;
  totalRows: number;
  nextOffset: number | null;
  truncated: boolean;
  warnings: string[];
}

export interface EvidenceDiffResponse {
  runId: string;
  findingId: string;
  evidenceIndex: number;
  evidenceCount: number;
  evidence: EvidenceRefDto;
  diff: FrozenDiffDto;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]> | undefined;
    traceId: string;
  };
}
