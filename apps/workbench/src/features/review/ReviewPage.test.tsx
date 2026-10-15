import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFindingId } from '@mergewarden/contracts';
import { ReviewPage } from './ReviewPage';
import { evidenceDiffResponse, evidenceRef, evidenceResponse, finding, jsonResponse, projectId, reportResponse, runId } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function LocationView() { const location = useLocation(); return <output aria-label="当前地址">{location.search}</output>; }
function renderReview(client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), search = '') {
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/projects/${projectId}/reviews/${runId}${search}`]}><Routes><Route path="/projects/:projectId/reviews/:runId" element={<><ReviewPage /><LocationView /></>} /></Routes></MemoryRouter></QueryClientProvider>);
}

describe('independent review detail and frozen evidence', () => {
  it('renders frozen additions and deletions with syntax colors and evidence line highlighting', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => Promise.resolve(jsonResponse(
      input.endsWith('/report') ? reportResponse() : input.includes('/diff?') ? evidenceDiffResponse() : evidenceResponse(),
    ))));
    renderReview();
    const diff = await screen.findByRole('region', { name: 'Git 风格统一差异' });
    expect(diff).toHaveTextContent('return value[0]');
    expect(diff).toHaveTextContent('return value["first"]');
    expect(screen.getByRole('listitem', { name: /新增行，HEAD 第 5 行，证据引用范围/ })).toHaveClass('diff-line-addition', 'is-evidence');
    expect(screen.getByRole('listitem', { name: /删除行，BASE 第 5 行/ })).toHaveClass('diff-line-deletion');
    await waitFor(() => expect(diff.querySelector('.syntax-token')).toBeInTheDocument());
    expect(diff.querySelectorAll('.syntax-token').length).toBeGreaterThan(0);
  });

  it('selects another finding through a URL link and reads its bound snapshot evidence', async () => {
    const response = reportResponse();
    const second = finding({ id: '../冻结/证据', title: '第二个问题', claim: '第二个问题的行为风险。', evidence: [evidenceRef({ path: 'src/second.py' })] });
    response.report.findings.push(second);
    response.review.findingCount = 2;
    const fetcher = vi.fn((input: string) => {
      if (input.endsWith('/report')) return Promise.resolve(jsonResponse(response));
      const selected = input.includes(encodeFindingId(second.id)) ? second : response.report.findings[0]!;
      return Promise.resolve(jsonResponse(input.includes('/diff?') ? evidenceDiffResponse(selected) : evidenceResponse(selected)));
    });
    vi.stubGlobal('fetch', fetcher);
    renderReview();
    await screen.findByText('已读取冻结证据');
    await userEvent.click(screen.getByRole('link', { name: /第二个问题/ }));
    await screen.findByText('第二个问题的行为风险。', { selector: 'dd' });
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => input.includes(`/findings/${encodeFindingId(second.id)}/evidence/0`))).toBe(true));
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('finding=');
    expect(screen.getByLabelText('src/second.py 第 4 至 5 行')).toHaveTextContent('value = request.get');
  });

  it('keeps cached completion hidden until a fresh delivery check succeeds', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['project', projectId, 'report', runId], reportResponse());
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; })));
    renderReview(client);
    expect(screen.queryByText('本次读取已核验交付')).not.toBeInTheDocument();
    resolveFetch(jsonResponse({ error: { code: 'REPORT_UNAVAILABLE', message: 'Report integrity mismatch', traceId: 'trace-2' } }, 409));
    expect(await screen.findByText('报告不可用')).toBeInTheDocument();
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();
  });

  it('renders a missing selected finding without falling back to another finding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(reportResponse())));
    renderReview(undefined, '?finding=missing');
    expect(await screen.findByText('所选问题不存在')).toBeInTheDocument();
    expect(screen.queryByLabelText('所选问题详情')).not.toBeInTheDocument();
  });
});
