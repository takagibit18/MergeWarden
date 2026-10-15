import { useInfiniteQuery } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Tag from 'antd/es/tag';
import type { DiffRowDto, EvidenceRefDto, FindingDto } from '@mergewarden/contracts';
import { getEvidenceDiff } from '../../shared/api/reviews';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/PageState';
import { useSyntaxTokens } from './useSyntaxTokens';
import { CodeTokens } from './CodeTokens';

const changeLabels = { added: '新增文件', deleted: '删除文件', modified: '文件有变更', unchanged: '文件未变更' } as const;

export function DiffViewer({ projectId, runId, finding, index, evidence }: { projectId: string; runId: string; finding: FindingDto; index: number; evidence: EvidenceRefDto }) {
  const query = useInfiniteQuery({
    queryKey: ['evidence-diff', projectId, runId, finding.id, index, evidence],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getEvidenceDiff({ projectId, runId, findingId: finding.id, index, expected: evidence, offset: pageParam, limit: 200 }, signal),
    getNextPageParam: page => page.diff.nextOffset ?? undefined,
    ...freshReadOptions,
  });
  const pages = query.data?.pages ?? [];
  const diff = pages[0]?.diff;
  const rowCount = pages.reduce((count, page) => count + page.diff.rows.length, 0);

  return (
    <section className="diff-section" aria-label="冻结源码变更差异">
      <div className="diff-section-heading"><div><h3>变更差异</h3><span className="diff-evidence-label">证据引用：{evidence.revision === 'head' ? 'HEAD' : 'BASE'} L{evidence.startLine}–{evidence.endLine}</span></div>
        {diff ? <Tag className={`diff-change diff-change-${diff.changeType}`}>{changeLabels[diff.changeType]}</Tag> : null}</div>
      {query.isPending || (query.isFetching && !query.data) ? <LoadingState label="正在核验冻结快照 diff…" />
        : query.isError ? <ErrorState title="冻结 diff 不可用" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : diff?.status === 'unavailable' ? <Alert showIcon type="warning" message="当前无法生成准确 diff" description={<ul className="compact-list">{diff.warnings.map((warning, itemIndex) => <li key={itemIndex}>{warning}</li>)}</ul>} />
        : diff ? <>
          {diff.warnings.length ? <Alert className="diff-warning" showIcon type="info" message="差异列表仍有后续页" description="加载后续行可继续浏览冻结快照中的变更。" /> : null}
          {diff.changeType === 'unchanged' || diff.totalRows === 0 ? <EmptyState title="冻结快照中没有文本变更" description="此引用仍绑定原始快照；当前文件没有可展示的增删行。" /> : <>
            <div className="diff-file-heading"><span className="mono">{diff.path}</span><span className="muted">{diff.base.exists ? 'BASE' : '空文件'} → {diff.head.exists ? 'HEAD' : '空文件'}</span></div>
            <div className="diff-scroll" role="region" aria-label="Git 风格统一差异" tabIndex={0}>
              <div className="diff-code" role="list">
                {pages.map(page => <DiffRows key={page.diff.offset} path={page.diff.path} rows={page.diff.rows} evidence={evidence} offset={page.diff.offset} />)}
              </div>
            </div>
            <div className="diff-pagination"><span>{rowCount} / {diff.totalRows} 行已载入</span>{query.hasNextPage ? <Button loading={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>加载更多差异</Button> : null}</div>
          </>}
          {diff.warnings.length && !diff.truncated ? <Alert className="diff-warning" showIcon type="warning" message="差异读取提示" description={<ul className="compact-list">{diff.warnings.map((warning, itemIndex) => <li key={itemIndex}>{warning}</li>)}</ul>} /> : null}
        </> : null}
    </section>
  );
}

function DiffRows({ path, rows, evidence, offset }: { path: string; rows: DiffRowDto[]; evidence: EvidenceRefDto; offset: number }) {
  const code = rows.filter(row => row.kind !== 'hunk').map(row => row.text).join('\n');
  const tokens = useSyntaxTokens(path, code);
  let tokenIndex = 0;
  return <>{rows.map((row, rowIndex) => {
    const key = `${offset}:${rowIndex}`;
    if (row.kind === 'hunk') return <div className="diff-hunk" role="listitem" key={key}>{row.text}</div>;
    const lineTokens = tokens?.[tokenIndex++];
    const evidenceLine = evidence.revision === 'head' ? row.headLine : row.baseLine;
    const highlighted = evidenceLine !== null && evidenceLine !== undefined && evidenceLine >= evidence.startLine && evidenceLine <= evidence.endLine;
    const ariaLabel = `${row.kind === 'addition' ? '新增' : row.kind === 'deletion' ? '删除' : '上下文'}行${row.baseLine === null ? '' : `，BASE 第 ${row.baseLine} 行`}${row.headLine === null ? '' : `，HEAD 第 ${row.headLine} 行`}${highlighted ? '，证据引用范围' : ''}`;
    return (
      <div className={`diff-line diff-line-${row.kind}${highlighted ? ' is-evidence' : ''}`} role="listitem" aria-label={ariaLabel} key={key}>
        <span className="diff-marker" aria-hidden="true">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' '}</span>
        <span className="diff-line-number" aria-label={row.baseLine === null ? '无 BASE 行' : `BASE 第 ${row.baseLine} 行`}>{row.baseLine ?? ''}</span>
        <span className="diff-line-number" aria-label={row.headLine === null ? '无 HEAD 行' : `HEAD 第 ${row.headLine} 行`}>{row.headLine ?? ''}</span>
        <code className="diff-line-text"><CodeTokens text={row.text || ' '} tokens={lineTokens} />{row.noFinalNewline ? <span className="diff-eof">无末尾换行</span> : null}</code>
      </div>
    );
  })}</>;
}
