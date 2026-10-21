import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFindingId } from '@mergewarden/contracts';
import { ApiError, describeError } from './client';
import { getEvidence, getEvidenceDiff, getHistory, getReport, getTask } from './reviews';
import { evidenceDiffResponse, evidenceRef, evidenceResponse, finding, historyResponse, jsonResponse, projectId, reportResponse, runId, taskId } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('read-only API boundary', () => {
  it('sends typed filters to a same-origin GET without browser credentials in the payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(historyResponse()));
    vi.stubGlobal('fetch', fetcher);
    await getHistory(projectId, { status: 'completed', scope: 'staged', cursor: 'next-page', limit: 20 });
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/projects/${projectId}/reviews?status=completed&scope=staged&limit=20&cursor=next-page`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('rejects malformed response data instead of accepting successful HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...historyResponse(), items: [{ status: 'completed' }] })));
    await expect(getHistory(projectId, {})).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('rejects report responses that have not passed the delivery gate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...reportResponse(), deliveryVerified: false })));
    await expect(getReport(projectId, runId)).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });

  it('rejects a report from another run or a finding from another snapshot', async () => {
    const response = reportResponse();
    response.report.findings[0]!.evidence[0]!.snapshotId = 'e'.repeat(64);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));
    await expect(getReport(projectId, runId)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('rejects a Known and accepted finding from another snapshot', async () => {
    const response = reportResponse();
    response.report.knownAccepted = [finding({ id: 'accepted', acceptedTradeoff: { skillId: 'sk_ratio_1', revision: 1, note: 'Accepted.' }, evidence: [evidenceRef({ snapshotId: 'e'.repeat(64) })] })];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));
    await expect(getReport(projectId, runId)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('rejects source pages that differ from the verified evidence reference', async () => {
    const selected = finding();
    const response = evidenceResponse(selected);
    response.source.path = 'src/another.py';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));
    await expect(getEvidence({ projectId, runId, findingId: selected.id, index: 0, expected: selected.evidence[0]! })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('uses opaque URL segments for dot-only and Unicode native finding IDs', async () => {
    const selected = finding({ id: '..' });
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(evidenceResponse(selected)));
    vi.stubGlobal('fetch', fetcher);
    await getEvidence({ projectId, runId, findingId: selected.id, index: 0, expected: selected.evidence[0]! });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/runs/${runId}/findings/${encodeFindingId('..')}/evidence/0`);
  });

  it('loads a bounded frozen diff only when it matches the selected evidence snapshot', async () => {
    const selected = finding();
    const response = evidenceDiffResponse(selected);
    expect(response.diff.head.contentSha256).not.toBe(response.evidence.contentSha256);
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal('fetch', fetcher);
    await expect(getEvidenceDiff({ projectId, runId, findingId: selected.id, index: 0, expected: selected.evidence[0]! })).resolves.toEqual(response);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/runs/${runId}/findings/${encodeFindingId(selected.id)}/evidence/0/diff?offset=0&limit=200`);
    response.runId = 'a0c5aa95-331b-449e-9751-d8ffafbb577a';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(response)));
    await expect(getEvidenceDiff({ projectId, runId, findingId: selected.id, index: 0, expected: selected.evidence[0]! })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    const truncatedSelectedSide = evidenceDiffResponse(selected);
    truncatedSelectedSide.diff.head.totalLines = 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(truncatedSelectedSide)));
    await expect(getEvidenceDiff({ projectId, runId, findingId: selected.id, index: 0, expected: selected.evidence[0]! })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('rejects a task response belonging to another task', async () => {
    const item = reportResponse().review;
    item.taskId = '96d7887a-6f34-4a41-802e-cf5d995c7507';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ item, done: true, canCancel: false })));
    await expect(getTask(projectId, taskId)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('reads native CLI run state when the record has no MCP task receipt', async () => {
    const item = reportResponse().review;
    delete item.taskId;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ item, done: false, canCancel: false })));
    await expect(getTask(projectId, runId)).resolves.toMatchObject({ item: { runId }, canCancel: false });
  });

  it('presents expired access as a local session issue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Session required', traceId: 'trace-1' } }, 401)));
    try { await getHistory(projectId, {}); throw new Error('Expected request to fail'); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect(describeError(error)).toContain('通过工作台启动命令重新打开'); }
  });

  it('localizes stable integrity errors and preserves their diagnostic identity', () => {
    const message = describeError(new ApiError('REPORT_INTEGRITY', 'Report integrity mismatch', 409, 'trace-check'));
    expect(message).toContain('报告产物未通过完整性核验');
    expect(message).toContain('trace-check');
    expect(describeError(new ApiError('NEW_CODE', 'Readable fallback', 500))).toBe('Readable fallback');
  });
});
