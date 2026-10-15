import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { projectParamsSchema } from '@mergewarden/contracts';
import { getHistory } from '../../shared/api/reviews';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { formatDate } from '../../shared/presentation';
import { Icon } from '../../shared/ui/Icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/PageState';
import { HistoryFilters } from './HistoryFilters';
import { HistoryTable } from './HistoryTable';
import { historySearch, readHistoryQuery } from './query-state';
import { useProjects } from '../projects/queries';

export function HistoryPage() {
  const { projectId = '' } = useParams();
  const validProject = projectParamsSchema.safeParse({ projectId }).success;
  const projects = useProjects();
  const project = projects.data?.projects.find(item => item.id === projectId);
  const [params, setParams] = useSearchParams();
  const parsed = readHistoryQuery(params);
  const filter = parsed.success ? parsed.data : { limit: 20 };
  const query = useQuery({
    queryKey: ['project', projectId, 'history', filter], queryFn: ({ signal }) => getHistory(projectId, filter, signal),
    enabled: validProject && parsed.success, ...freshReadOptions,
  });
  const response = query.data;
  const verified = response?.items.filter(item => item.reportAvailability === 'verified').length ?? 0;
  const findingCount = response?.items.reduce((count, item) => count + (item.findingCount ?? 0), 0) ?? 0;

  return (
    <>
      <div className="page-heading">
        <div><h1>审查历史</h1><p className="page-description">查看审查结论与冻结源码证据。</p></div>
        <Button icon={<Icon name="refresh" size={17} />} loading={query.isFetching} disabled={!validProject || !parsed.success} onClick={() => { void query.refetch(); }}>刷新记录</Button>
      </div>
      <section className="surface filter-surface" aria-label="历史筛选"><HistoryFilters query={filter} workspaces={project?.workspaces ?? []} onApply={next => setParams(historySearch(next))} /></section>
      {projects.isError ? <Alert className="history-warning" type="warning" showIcon message="项目目录信息暂时不可用" description="历史记录仍按当前项目读取。重试后可选择已登记目录。" action={<Button onClick={() => { void projects.refetch(); }}>重试</Button>} /> : null}
      {!validProject ? <ErrorState title="项目标识不可用" description="请从项目列表重新选择项目。" /> : !parsed.success ? <ErrorState title="筛选参数不可用" description="地址中的状态、范围或分页参数不符合接口要求，请重置筛选。" onRetry={() => setParams(new URLSearchParams())} />
        : query.isFetching || query.isPending ? <LoadingState label="正在同步并读取审查历史索引…" />
        : query.isError ? <ErrorState title="历史记录读取失败" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : response ? <>
          <dl className="history-summary" aria-label="当前页统计">
            <div><dt>本页记录</dt><dd>{response.items.length}</dd></div>
            <div title="详情会重新核验原生报告"><dt>索引中已核验</dt><dd>{verified}</dd></div>
            <div title="不能作为已完成报告"><dt>未确认或不可用</dt><dd>{response.items.length - verified}</dd></div>
            <div><dt>本页问题</dt><dd>{findingCount}</dd></div>
          </dl>
          {response.sync.skipped > 0 || response.sync.truncated ? <Alert className="history-warning" showIcon type="warning" message="历史读取存在限制" description={[response.sync.skipped > 0 ? `${response.sync.skipped} 条记录未通过读取或校验。` : '', response.sync.truncated ? '本次扫描已达到上限，刷新可继续同步；当前列表不代表完整历史。' : ''].join(' ')} /> : null}
          <section className="surface records-surface" aria-label="审查记录">
            <div className="records-heading"><p className="muted small">“运行中”不保证进程仍活跃；打开详情会重新核验报告。</p><span className="sync-label">{response.sync.lastSyncedAt ? `同步于 ${formatDate(response.sync.lastSyncedAt)}` : '尚未同步'}</span></div>
            {response.items.length ? <HistoryTable projectId={projectId} items={response.items} workspaces={project?.workspaces ?? []} /> : <EmptyState title="暂无符合条件的审查记录" description={filter.status || filter.scope || filter.workspaceId ? '可以调整筛选，或查看全部审查记录。' : '使用 MergeWarden CLI 或 MCP 完成审查后，记录会出现在这里。'} action={filter.status || filter.scope || filter.workspaceId ? <Button onClick={() => setParams(new URLSearchParams())}>查看全部记录</Button> : undefined} />}
            <div className="history-pagination"><span className="muted small">每页最多 {filter.limit} 条 · 已扫描 {response.sync.scanned} 条记录</span><div className="pagination-actions"><Button disabled={!filter.cursor} onClick={() => setParams(historySearch({ ...filter, cursor: undefined }))}>第一页</Button><Button disabled={!response.nextCursor} onClick={() => { if (response.nextCursor) setParams(historySearch({ ...filter, cursor: response.nextCursor })); }}>下一页<Icon name="chevron" size={13} /></Button></div></div>
          </section>
        </> : null}
    </>
  );
}
