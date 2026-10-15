import {
  configResponseSchema, diffQuerySchema, encodeFindingId, evidenceDiffResponseSchema, evidenceParamsSchema,
  evidenceResponseSchema, historyQuerySchema, historyResponseSchema, projectParamsSchema,
  projectRegistrationSchema, projectSchema, projectsResponseSchema, reportResponseSchema,
  taskParamsSchema, taskResponseSchema, workspaceRegistrationSchema,
} from '@mergewarden/contracts';
import type { EvidenceRefDto, HistoryQuery, RegisterProjectInput, RegisterWorkspaceInput } from '@mergewarden/contracts';
import { getJson, identityError, postJson } from './client';

function projectPath(projectId: string) {
  projectParamsSchema.parse({ projectId });
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function getConfig(signal?: AbortSignal) {
  return getJson('/config', configResponseSchema, signal);
}

export function getProjects(signal?: AbortSignal) {
  return getJson('/projects', projectsResponseSchema, signal);
}

export function registerProject(input: RegisterProjectInput) {
  return postJson('/projects', projectRegistrationSchema.parse(input), projectSchema);
}

export async function registerWorkspace(projectId: string, input: RegisterWorkspaceInput) {
  const response = await postJson(`${projectPath(projectId)}/workspaces`, workspaceRegistrationSchema.parse(input), projectSchema);
  if (response.id !== projectId) throw identityError();
  return response;
}

export async function getHistory(projectId: string, query: HistoryQuery, signal?: AbortSignal) {
  const valid = historyQuerySchema.parse(query);
  const params = new URLSearchParams();
  if (valid.workspaceId) params.set('workspaceId', valid.workspaceId);
  if (valid.status) params.set('status', valid.status);
  if (valid.scope) params.set('scope', valid.scope);
  params.set('limit', String(valid.limit));
  if (valid.cursor) params.set('cursor', valid.cursor);
  const response = await getJson(`${projectPath(projectId)}/reviews?${params}`, historyResponseSchema, signal);
  if (response.projectId !== projectId || response.items.some(item => item.projectId !== projectId
    || (valid.workspaceId !== undefined && item.workspaceId !== valid.workspaceId))) throw identityError();
  return response;
}

export async function getReport(projectId: string, runId: string, signal?: AbortSignal) {
  taskParamsSchema.parse({ id: runId });
  const response = await getJson(`${projectPath(projectId)}/runs/${encodeURIComponent(runId)}/report`, reportResponseSchema, signal);
  const { report, review } = response;
  if (review.projectId !== projectId || report.runId !== runId || review.runId !== runId || review.snapshotId !== report.snapshot.id
    || review.reportAvailability !== 'verified' || review.status !== report.status
    || report.findings.some(finding => finding.evidence.some(ref => ref.snapshotId !== report.snapshot.id))) throw identityError();
  return response;
}

export async function getTask(projectId: string, taskId: string, signal?: AbortSignal) {
  taskParamsSchema.parse({ id: taskId });
  const response = await getJson(`${projectPath(projectId)}/tasks/${encodeURIComponent(taskId)}`, taskResponseSchema, signal);
  if (response.item.projectId !== projectId || (response.item.taskId !== taskId && response.item.runId !== taskId)) throw identityError();
  return response;
}

export interface EvidenceInput { projectId: string; runId: string; findingId: string; index: number; expected: EvidenceRefDto }

function evidencePath(input: EvidenceInput) {
  const { projectId, runId, findingId, index } = input;
  evidenceParamsSchema.parse({ id: runId, findingId, index });
  return `${projectPath(projectId)}/runs/${encodeURIComponent(runId)}/findings/${encodeFindingId(findingId)}/evidence/${index}`;
}

function matchesEvidence(actual: EvidenceRefDto, expected: EvidenceRefDto) {
  return actual.snapshotId === expected.snapshotId && actual.revision === expected.revision && actual.path === expected.path
    && actual.startLine === expected.startLine && actual.endLine === expected.endLine && actual.contentSha256 === expected.contentSha256;
}

export async function getEvidence(input: EvidenceInput, signal?: AbortSignal) {
  const { runId, findingId, index, expected } = input;
  const response = await getJson(evidencePath(input), evidenceResponseSchema, signal);
  const { evidence, source } = response;
  if (response.runId !== runId || response.findingId !== findingId || response.evidenceIndex !== index
    || !matchesEvidence(evidence, expected)
    || source.snapshotId !== evidence.snapshotId || source.revision !== evidence.revision || source.path !== evidence.path
    || (source.status === 'ok' && (source.contentSha256 !== evidence.contentSha256 || source.startLine !== evidence.startLine || source.endLine !== evidence.endLine))) throw identityError();
  return response;
}

export async function getEvidenceDiff(input: EvidenceInput & { offset?: number; limit?: number }, signal?: AbortSignal) {
  const { runId, findingId, index, expected } = input;
  const page = diffQuerySchema.parse({ offset: input.offset ?? 0, limit: input.limit ?? 200 });
  const response = await getJson(`${evidencePath(input)}/diff?offset=${page.offset}&limit=${page.limit}`, evidenceDiffResponseSchema, signal);
  const { evidence, diff } = response;
  const selectedSide = diff[expected.revision];
  if (response.runId !== runId || response.findingId !== findingId || response.evidenceIndex !== index
    || !matchesEvidence(evidence, expected) || diff.snapshotId !== expected.snapshotId || diff.path !== expected.path
    || diff.offset !== page.offset || diff.rows.length > page.limit
    || (diff.status === 'ok' && (!selectedSide.exists || expected.endLine > selectedSide.totalLines))) throw identityError();
  return response;
}
