import { useQuery } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Tag from 'antd/es/tag';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { scopedTaskParamsSchema } from '@mergewarden/contracts';
import type { ReportResponse } from '@mergewarden/contracts';
import { getReport } from '../../shared/api/reviews';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { formatDate, shortId } from '../../shared/presentation';
import { Icon } from '../../shared/ui/Icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/PageState';
import { StatusTag } from '../../shared/ui/StatusTag';
import { scopeLabels } from '../history/query-state';
import { FindingList } from './FindingList';
import { FindingDetail } from './FindingDetail';
import { CopyValue } from '../../shared/ui/CopyValue';
import { projectReviewsPath } from '../projects/queries';

export function ReviewPage() {
  const { projectId = '', runId = '' } = useParams();
  const valid = scopedTaskParamsSchema.safeParse({ projectId, id: runId }).success;
  const query = useQuery({ queryKey: ['project', projectId, 'report', runId], queryFn: ({ signal }) => getReport(projectId, runId, signal), enabled: valid, ...freshReadOptions });

  return (
    <>
      <Link className="back-link" to={projectReviewsPath(projectId)}><Icon name="arrow" size={16} />返回审查历史</Link>
      <div className="page-heading"><div><h1>审查详情</h1><CopyValue value={runId} label="运行 ID" length={20} /></div><Button icon={<Icon name="refresh" size={16} />} disabled={!valid} loading={query.isFetching} onClick={() => { void query.refetch(); }}>重新核验</Button></div>
      {!valid ? <ErrorState title="运行标识不可用" description="当前地址没有有效的审查运行 ID。" />
        : query.isPending || query.isFetching ? <LoadingState label="正在重新核验报告交付与运行身份…" />
        : query.isError ? <ErrorState title="报告不可用" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : query.data ? <VerifiedReview projectId={projectId} response={query.data} /> : null}
    </>
  );
}

function VerifiedReview({ projectId, response }: { projectId: string; response: ReportResponse }) {
  const [params, setParams] = useSearchParams();
  const { review, report } = response;
  const requestedFinding = params.get('finding');
  const selected = requestedFinding === null ? report.findings[0] : report.findings.find(finding => finding.id === requestedFinding);
  const rawEvidence = params.get('evidence');
  const evidenceIndex = rawEvidence === null ? 0 : /^\d+$/.test(rawEvidence) ? Number(rawEvidence) : -1;
  const covered = Object.values(report.coverage).filter(value => value === 'done').length;
  const totalPaths = Object.keys(report.coverage).length;
  const uncovered = totalPaths - covered;

  return (
    <>
      <section className="surface report-summary" aria-label="报告概览">
        <div className="report-summary-heading"><div className="report-tags"><StatusTag status={report.status} /><Tag className="verification-tag" icon={<Icon name="check" size={14} />}>本次读取已核验交付</Tag>{review.scope ? <Tag>{scopeLabels[review.scope]}</Tag> : null}</div><span className="muted small">{review.finishedAt ? `结束于 ${formatDate(review.finishedAt, true)}` : `创建于 ${formatDate(review.createdAt, true)}`}</span></div>
        <h2>审查摘要</h2><p className="summary-text">{report.summary}</p>
        <div className="report-metadata"><Meta label="发现问题" value={`${report.findings.length} 项`} /><Meta label="差异覆盖" value={`${covered} / ${totalPaths} 个文件`} /><Meta label="模型" value={review.model ? `${review.model.provider} / ${review.model.modelId}` : '未记录'} /><Meta label="源码快照" value={shortId(report.snapshot.id, 16)} fullValue={report.snapshot.id} mono /></div>
      </section>
      {uncovered > 0 ? <Alert className="coverage-warning" showIcon type="warning" message={`还有 ${uncovered} 个文件未完成覆盖`} description="报告中的问题和证据需结合未覆盖范围一起复核。" /> : null}
      <div className="review-note"><Icon name="shield" size={16} /><span>审查结论供人工复核。证据完整性校验不代表已证明缺陷语义。</span></div>
      {report.findings.length ? <div className="review-workspace"><FindingList findings={report.findings} selectedId={selected?.id} search={params} />{selected ? <FindingDetail projectId={projectId} finding={selected} runId={report.runId} evidenceIndex={evidenceIndex} onEvidenceSelect={index => { const next = new URLSearchParams(params); next.set('finding', selected.id); next.set('evidence', String(index)); setParams(next, { replace: true }); }} /> : <EmptyState title="所选问题不存在" description="地址中的问题 ID 不属于当前报告，请从左侧列表重新选择。" />}</div> : <EmptyState title="本报告没有提交问题" description={report.status === 'completed' ? '本次审查已完成并通过报告交付核验，未提交 finding。' : '本次报告没有 finding；请结合报告状态、摘要与覆盖范围判断审查结果。'} />}
      <section className="surface coverage-surface" aria-label="文件覆盖"><div className="section-heading"><h2>文件覆盖</h2><span className="muted small">冻结审查范围</span></div><div className="coverage-list">{Object.entries(report.coverage).map(([path, status]) => <div key={path} className="coverage-row"><span className="mono">{path}</span><Tag className={`coverage-tag coverage-${status}`}>{status === 'done' ? '已覆盖' : status === 'failed' ? '覆盖失败' : '待覆盖'}</Tag></div>)}</div>{totalPaths === 0 ? <p className="muted">此报告未记录覆盖路径。</p> : null}</section>
    </>
  );
}

function Meta({ label, value, fullValue, mono = false }: { label: string; value: string; fullValue?: string; mono?: boolean }) {
  return <div><span className="metadata-label">{label}</span><strong className={mono ? 'mono' : undefined} title={fullValue}>{value}</strong></div>;
}
