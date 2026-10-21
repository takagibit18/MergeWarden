import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPage } from './HistoryPage';
import { HistoryTable } from './HistoryTable';
import { historyItem, historyResponse, jsonResponse, projectFixture, projectId, runId, taskId } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function LocationView() { const location = useLocation(); return <output aria-label="当前地址">{location.pathname}{location.search}</output>; }
function renderHistory(path = `/projects/${projectId}/reviews`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/projects/:projectId/reviews" element={<><HistoryPage /><LocationView /></>} /></Routes></MemoryRouter></QueryClientProvider>);
}

describe('history navigation and URL state', () => {
  it('restores filters from the URL and preserves them when advancing the cursor', async () => {
    const fetcher = vi.fn((input: string) => Promise.resolve(jsonResponse(input === '/api/v1/projects'
      ? { defaultProjectId: projectId, projects: [projectFixture()] }
      : historyResponse({ nextCursor: 'cursor-b' }))));
    vi.stubGlobal('fetch', fetcher);
    renderHistory(`/projects/${projectId}/reviews?status=partial&scope=staged&cursor=cursor-a`);
    await screen.findByRole('link', { name: '详情' });
    expect(fetcher.mock.calls.some(([input]) => input === `/api/v1/projects/${projectId}/reviews?status=partial&scope=staged&limit=20&cursor=cursor-a`)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /下一页/ }));
    await waitFor(() => expect(screen.getByLabelText('当前地址')).toHaveTextContent('status=partial&scope=staged&cursor=cursor-b'));
    expect(fetcher.mock.calls.some(([input]) => input.includes(`/projects/${projectId}/reviews?`) && input.includes('cursor=cursor-b'))).toBe(true);
  });

  it('does not request history for invalid URL parameters', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderHistory(`/projects/${projectId}/reviews?status=invented-status`);
    expect(await screen.findByText('筛选参数不可用')).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => input.includes('/reviews?'))).toBe(false);
  });

  it('links unfinished task records to native task state and verified reports to details', () => {
    const pending = historyItem({ id: taskId, status: 'running', reportAvailability: 'not_delivered' });
    render(<MemoryRouter><HistoryTable projectId={projectId} items={[pending, historyItem()]} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '任务' })).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId}`);
    expect(screen.getByRole('link', { name: '详情' })).toHaveAttribute('href', `/projects/${projectId}/reviews/${runId}`);
  });

  it('shows the Known and accepted count only when a verified report has one', () => {
    render(<MemoryRouter><HistoryTable projectId={projectId} items={[historyItem({ findingCount: 2, knownAcceptedCount: 3 }), historyItem({ id: 'other', runId: 'other', findingCount: 1 })]} /></MemoryRouter>);
    expect(screen.getAllByText(/^已接受 /)).toHaveLength(1);
    expect(screen.getByText('已接受 3')).toBeInTheDocument();
  });

  it('links unfinished native CLI runs to task state even without an MCP receipt', () => {
    const pending = historyItem({ taskId: undefined, status: 'running', reportAvailability: 'not_delivered' });
    render(<MemoryRouter><HistoryTable projectId={projectId} items={[pending]} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '任务' })).toHaveAttribute('href', `/projects/${projectId}/tasks/${runId}`);
  });

  it('shows an honest empty state without generated reviews', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => Promise.resolve(jsonResponse(input === '/api/v1/projects'
      ? { defaultProjectId: projectId, projects: [projectFixture()] }
      : historyResponse({ items: [] })))));
    renderHistory();
    expect(await screen.findByText('暂无符合条件的审查记录')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '详情' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建审查/ })).not.toBeInTheDocument();
  });
});
