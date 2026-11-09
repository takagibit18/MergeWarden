import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationSection } from './NavigationSection';
import { navigationGraphModel } from './model';
import { layoutGraph } from './layout';
import { jsonResponse, navigationResponse, navigationSourceResponse, projectId, runId } from '../../test/fixtures';

// The canvas is React Flow + ELK and is verified by layout tests below; here it is replaced by a probe.
vi.mock('./NavigationCanvas', () => ({
  default: ({ model, onSelect }: { model: ReturnType<typeof navigationGraphModel>; onSelect: (id: string) => void }) => (
    <div aria-label="结构导航图" data-highlighted={[...model.highlighted].sort().join(',')} data-edges={model.edges.length}>
      <button type="button" onClick={() => onSelect('handle')}>canvas-select-handle</button>
    </div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

function renderSection(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher);
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>
    <NavigationSection projectId={projectId} runId={runId} findingTitles={{ 'finding-1': '调用方缺少空值处理' }} />
  </MemoryRouter></QueryClientProvider>);
}

describe('navigation graph model', () => {
  it('groups members by file, filters relations and highlights a step', () => {
    const view = navigationResponse().view!;
    const all = navigationGraphModel(view, { relations: ['CALLS'] });
    expect(all.groups.map(group => [group.path, group.children.map(node => node.id)])).toEqual([['src/api.py', ['handle']], ['src/service.py', ['load']]]);
    expect(all.edges.map(edge => [edge.sourceId, edge.targetId])).toEqual([['handle', 'load']]);
    expect(all.highlighted.size).toBe(0);
    expect(navigationGraphModel(view, { relations: ['IMPORTS'] }).edges).toEqual([]);
    expect([...navigationGraphModel(view, { relations: ['CALLS'], stepSeq: 2 }).highlighted].sort()).toEqual(['handle', 'load']);
    expect([...navigationGraphModel(view, { relations: ['CALLS'], stepSeq: 1 }).highlighted]).toEqual(['load']);
  });

  it('lays out files as compound nodes containing their members', async () => {
    const placed = await layoutGraph(navigationGraphModel(navigationResponse().view!, { relations: ['CALLS'] }));
    const handle = placed.find(item => item.id === 'handle')!, group = placed.find(item => item.id === 'file:src/api.py')!;
    expect(handle.parentId).toBe('file:src/api.py');
    expect(handle.x + handle.width).toBeLessThanOrEqual(group.width);
    expect(placed.filter(item => !item.parentId)).toHaveLength(2);
  });
});

describe('navigation section', () => {
  it('makes no request until opened, then shows verified steps, entities and limits', async () => {
    const response = navigationResponse(); response.view!.limitations = ['Model LocAgent retrieval calls are not recorded.'];
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse(response)));
    renderSection(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '查看结构导航' }));
    const steps = await screen.findByRole('list', { name: '导航步骤' });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/projects/${projectId}/runs/${runId}/navigation`);
    expect(within(steps).getAllByRole('listitem')).toHaveLength(2);
    expect(steps).toHaveTextContent('查找 “load”，返回 1 个实体');
    expect(steps).toHaveTextContent('入向 调用，返回 1 条关系');
    expect(screen.getByText('导航记录不完整')).toBeInTheDocument();
    expect(screen.getByText('Model LocAgent retrieval calls are not recorded.')).toBeInTheDocument();
    expect(await screen.findByLabelText('结构导航图')).toHaveAttribute('data-edges', '1');
  });

  it('highlights a step, selects an entity from the accessible list and reads its head source', async () => {
    const fetcher = vi.fn((input: string) => Promise.resolve(jsonResponse(input.endsWith('/source') ? navigationSourceResponse() : navigationResponse())));
    renderSection(fetcher);
    await userEvent.click(screen.getByRole('button', { name: '查看结构导航' }));
    await userEvent.click(await screen.findByRole('button', { name: /#2/ }));
    expect(await screen.findByLabelText('结构导航图')).toHaveAttribute('data-highlighted', 'handle,load');
    await userEvent.click(within(screen.getByRole('list', { name: '实体列表' })).getByRole('button', { name: /load/ }));
    const detail = screen.getByRole('region', { name: '所选实体' });
    expect(detail).toHaveTextContent('证据位置重叠');
    expect(within(detail).getByRole('link', { name: '调用方缺少空值处理' })).toHaveAttribute('href', '/?finding=finding-1');
    await userEvent.click(screen.getByRole('button', { name: 'canvas-select-handle' }));
    await userEvent.click(within(screen.getByRole('region', { name: '所选实体' })).getByRole('button', { name: '查看 HEAD 源码' }));
    const code = await screen.findByLabelText('src/api.py 第 4 至 5 行');
    expect(code).toHaveTextContent('return load(request)');
    expect(code.querySelector('.is-evidence')).toBeNull();
    expect((fetcher.mock.calls as unknown as [string][]).some(([input]) => input === `/api/v1/projects/${projectId}/runs/${runId}/navigation/entities/handle/source`)).toBe(true);
  });

  it('states not_recorded and unavailable explicitly instead of showing an empty graph', async () => {
    renderSection(vi.fn(() => Promise.resolve(jsonResponse({ runId, snapshotId: navigationResponse().snapshotId, state: 'not_recorded' }))));
    await userEvent.click(screen.getByRole('button', { name: '查看结构导航' }));
    expect(await screen.findByText(/本次运行没有导航记录/)).toBeInTheDocument();
  });

  it('shows the recorded reason when navigation is unavailable and rejects mismatched identities', async () => {
    renderSection(vi.fn(() => Promise.resolve(jsonResponse({ runId, snapshotId: navigationResponse().snapshotId, state: 'unavailable', reason: 'Navigation record could not be written' }))));
    await userEvent.click(screen.getByRole('button', { name: '查看结构导航' }));
    expect(await screen.findByText('Navigation record could not be written')).toBeInTheDocument();
  });

  it('treats a response for another run as an identity failure', async () => {
    renderSection(vi.fn(() => Promise.resolve(jsonResponse(navigationResponse({ runId: '313fe1a9-3e96-4f3f-8549-04167722ee49' })))));
    await userEvent.click(screen.getByRole('button', { name: '查看结构导航' }));
    expect(await screen.findByText('导航记录不可用')).toBeInTheDocument();
  });
});
