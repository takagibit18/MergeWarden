import type { EvidenceDiffResponse, EvidenceRefDto, EvidenceResponse, FindingDto, HistoryItem, HistoryResponse, ProjectDto, ReportResponse } from '@mergewarden/contracts';

export const projectId = 'd7fa74b4-532f-4c73-86ca-1ff3c3db84a5';
export const workspaceId = 'c'.repeat(64);
export const runId = 'd6c8a2d4-e8ba-4f3f-a8d3-851441a41383';
export const taskId = '313fe1a9-3e96-4f3f-8549-04167722ee49';
export const snapshotId = 'a'.repeat(64);
export const contentSha256 = 'b'.repeat(64);
export const repositoryPath = 'E:\\fixtures\\project';

export function projectFixture(): ProjectDto {
  return { id: projectId, name: 'fixture-project', repositoryPath, createdAt: '2026-10-10T09:00:00.000Z', workspaces: [
    { id: workspaceId, name: 'project', path: repositoryPath, kind: 'primary', registeredAt: '2026-10-10T09:00:00.000Z' },
  ] };
}

export function evidenceRef(overrides: Partial<EvidenceRefDto> = {}): EvidenceRefDto {
  return { snapshotId, revision: 'head', path: 'src/service.py', startLine: 4, endLine: 5, contentSha256, ...overrides };
}

export function finding(overrides: Partial<FindingDto> = {}): FindingDto {
  return { id: 'finding-1', title: '调用方缺少空值处理', claim: '空值沿调用链进入索引访问。', trigger: '输入为空且进入当前分支。', impact: '请求处理失败。', severity: 'high', evidence: [evidenceRef()], ...overrides };
}

export function historyItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return { id: runId, projectId, workspaceId, title: '检查请求读取的空值边界', titleSource: 'summary', runId, taskId, repositoryPath, createdAt: '2026-10-10T09:00:00.000Z', finishedAt: '2026-10-10T09:03:00.000Z', status: 'completed', scope: 'staged', snapshotId, findingCount: 1, reportAvailability: 'verified', model: { provider: 'fixture-provider', modelId: 'fixture-model' }, ...overrides };
}

export function historyResponse(overrides: Partial<HistoryResponse> = {}): HistoryResponse {
  return { projectId, repositoryPath, items: [historyItem()], nextCursor: null, sync: { lastSyncedAt: '2026-10-10T09:04:00.000Z', scanned: 1, skipped: 0, truncated: false }, ...overrides };
}

export function reportResponse(): ReportResponse {
  return { review: historyItem(), deliveryVerified: true, report: { schemaVersion: 1, runId, snapshot: { id: snapshotId, repositoryId: 'fixture-repository', inputFingerprint: 'c'.repeat(64), configurationFingerprint: 'd'.repeat(64) }, status: 'completed', summary: '已复核变更与相关调用方。', findings: [finding()], coverage: { 'src/service.py': 'done' }, publication: 'not_requested' } };
}

export function evidenceResponse(selected = finding(), index = 0): EvidenceResponse {
  const evidence = selected.evidence[index];
  if (!evidence) throw new Error('Fixture evidence does not exist');
  return { runId, findingId: selected.id, evidenceIndex: index, evidenceCount: selected.evidence.length, evidence, source: { snapshotId: evidence.snapshotId, revision: evidence.revision, path: evidence.path, status: 'ok', text: 'value = request.get("value")\nreturn value[0]', startLine: evidence.startLine, endLine: evidence.endLine, totalLines: 20, contentSha256: evidence.contentSha256, truncated: false, warnings: [] } };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

export function evidenceDiffResponse(selected = finding(), index = 0, offset = 0): EvidenceDiffResponse {
  const evidence = selected.evidence[index];
  if (!evidence) throw new Error('Fixture evidence does not exist');
  const rows: EvidenceDiffResponse['diff']['rows'] = [
    { kind: 'hunk', text: '@@ -3,2 +3,2 @@', baseLine: null, headLine: null, hunk: { baseStart: 3, baseCount: 2, headStart: 3, headCount: 2 } },
    { kind: 'context', text: 'value = request.get("value")', baseLine: 4, headLine: 4 },
    { kind: 'deletion', text: 'return value[0]', baseLine: 5, headLine: null },
    { kind: 'addition', text: 'return value["first"]', baseLine: null, headLine: 5 },
  ];
  const pageRows = rows.slice(offset, offset + 200);
  const nextOffset = offset + pageRows.length < rows.length ? offset + pageRows.length : null;
  return { runId, findingId: selected.id, evidenceIndex: index, evidenceCount: selected.evidence.length, evidence, diff: {
    snapshotId: evidence.snapshotId, path: evidence.path, status: 'ok', changeType: 'modified',
    base: { exists: true, contentSha256: 'd'.repeat(64), totalLines: 20, endsWithNewline: true, mode: '100644' },
    head: { exists: true, contentSha256: 'e'.repeat(64), totalLines: 20, endsWithNewline: true, mode: '100644' },
    rows: pageRows, offset, totalRows: rows.length, nextOffset, truncated: nextOffset !== null, warnings: nextOffset === null ? [] : ['Frozen diff display is paginated; additional rows remain.'],
  } };
}
