import { useQuery } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Select from 'antd/es/select';
import Tag from 'antd/es/tag';
import type { FindingDto } from '@mergewarden/contracts';
import { getEvidence } from '../../shared/api/reviews';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { shortId } from '../../shared/presentation';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/PageState';
import { Icon } from '../../shared/ui/Icon';
import { SourceCodeViewer } from './SourceCodeViewer';
import type { AvailableSource } from './SourceCodeViewer';
import { DiffViewer } from './DiffViewer';

export function EvidenceViewer({ projectId, runId, finding, index, onSelect }: { projectId: string; runId: string; finding: FindingDto; index: number; onSelect: (index: number) => void }) {
  const expected = finding.evidence[index];
  const query = useQuery({
    queryKey: ['evidence', runId, finding.id, index, expected],
    queryFn: ({ signal }) => { if (!expected) throw new Error('Evidence not selected'); return getEvidence({ projectId, runId, findingId: finding.id, index, expected }, signal); },
    enabled: Boolean(expected), ...freshReadOptions,
  });

  if (!finding.evidence.length) return <EmptyState title="此问题没有可读取的证据" description="当前报告未提供源码引用，无法展示冻结源码。" />;
  if (!expected) return <ErrorState title="证据索引不可用" description="地址指定的证据不存在于当前问题中。" />;

  const source = query.data?.source;

  return (
    <section className="evidence-section" aria-label="冻结源码证据">
      <div className="evidence-section-heading"><h3>源码证据</h3><Tag icon={<Icon name="link" size={13} />}>绑定不可变快照</Tag></div>
      <label className="evidence-select-label" htmlFor="evidence-selector">选择证据</label>
      <Select id="evidence-selector" className="evidence-selector" value={index} onChange={onSelect} aria-label="选择证据" options={finding.evidence.map((ref, itemIndex) => ({ value: itemIndex, label: `${itemIndex + 1}. ${ref.path}:${ref.startLine}–${ref.endLine} · ${ref.revision}` }))} />
      <div className="evidence-identity"><span title={expected.snapshotId}>快照 <code>{shortId(expected.snapshotId, 16)}</code></span><span>{expected.revision === 'head' ? 'HEAD 版本' : 'BASE 版本'}</span></div>
      {query.isPending || query.isFetching ? <LoadingState label="正在核验并读取冻结源码…" />
        : query.isError ? <ErrorState title="源码证据不可用" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : source?.status === 'unavailable' ? <EmptyState title="冻结源码当前不可用" description="源码产物未能读取，当前不能核查该引用。" action={<Button onClick={() => { void query.refetch(); }}>重新读取</Button>} />
        : source?.status === 'ok' ? <>
          <div className="source-frame"><div className="source-title"><Icon name="file" size={15} /><span className="mono">{source.path}</span><span className="source-range">证据引用 · L{source.startLine}–{source.endLine}</span></div><SourceCodeViewer source={source as AvailableSource} /></div>
          <div className="evidence-verification"><span className="delivery-ok"><Icon name="check" size={14} />已读取冻结证据</span><span className="mono" title={source.contentSha256}>SHA256 {shortId(source.contentSha256, 14)}</span></div>
          {source.truncated || source.warnings.length ? <Alert showIcon type="warning" message={source.truncated ? '源码返回有截断' : '证据读取提示'} description={<ul className="compact-list">{source.warnings.map((warning, itemIndex) => <li key={itemIndex}>{warning}</li>)}{source.truncated ? <li>当前内容不代表完整请求范围。</li> : null}</ul>} /> : null}
          <DiffViewer projectId={projectId} runId={runId} finding={finding} index={index} evidence={expected} />
        </> : null}
    </section>
  );
}
