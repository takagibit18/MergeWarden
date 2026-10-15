import { useQuery } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Tag from 'antd/es/tag';
import { Link, useParams } from 'react-router-dom';
import { scopedTaskParamsSchema } from '@mergewarden/contracts';
import { getTask } from '../../shared/api/reviews';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { formatDate } from '../../shared/presentation';
import { Icon } from '../../shared/ui/Icon';
import { ErrorState, LoadingState } from '../../shared/ui/PageState';
import { StatusTag } from '../../shared/ui/StatusTag';
import { scopeLabels } from '../history/query-state';
import { projectReviewsPath } from '../projects/queries';
import { CopyValue } from '../../shared/ui/CopyValue';

export function TaskPage() {
  const { projectId = '', taskId = '' } = useParams();
  const valid = scopedTaskParamsSchema.safeParse({ projectId, id: taskId }).success;
  const query = useQuery({ queryKey: ['project', projectId, 'task', taskId], queryFn: ({ signal }) => getTask(projectId, taskId, signal), enabled: valid, ...freshReadOptions });
  const item = query.data?.item;

  return (
    <>
      <Link className="back-link" to={projectReviewsPath(projectId)}><Icon name="arrow" size={16} />返回审查历史</Link>
      <div className="page-heading"><div><h1>任务状态</h1><CopyValue value={taskId} label="任务 ID" length={20} /></div><Button icon={<Icon name="refresh" size={16} />} disabled={!valid} loading={query.isFetching} onClick={() => { void query.refetch(); }}>刷新状态</Button></div>
      {!valid ? <ErrorState title="任务标识不可用" description="当前地址没有有效的任务 ID。" />
        : query.isPending || query.isFetching ? <LoadingState label="正在读取原生任务状态…" />
        : query.isError ? <ErrorState title="任务状态读取失败" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : item ? <section className="surface task-surface"><div className="report-tags"><StatusTag status={item.status} />{item.scope ? <Tag>{scopeLabels[item.scope]}</Tag> : null}<Tag>{item.reportAvailability === 'verified' ? '报告已核验' : item.reportAvailability === 'unavailable' ? '报告不可用' : '未确认报告交付'}</Tag></div><dl className="task-metadata"><div><dt>创建时间</dt><dd>{formatDate(item.createdAt, true)}</dd></div><div><dt>模型</dt><dd>{item.model ? `${item.model.provider} / ${item.model.modelId}` : '未记录'}</dd></div><div><dt>运行 ID</dt><dd className="mono">{item.runId ?? '尚未关联运行'}</dd></div><div><dt>源码快照</dt><dd className="mono">{item.snapshotId ?? '尚未记录'}</dd></div></dl><Alert showIcon type="info" message="任务状态与报告交付分别核验" description="状态来自最后保存记录。“运行中”不保证进程仍活跃；仅完整读取并核验的报告能确认交付。" />{item.error ? <Alert className="state-action" showIcon type="warning" message={item.error.message} /> : null}{item.runId ? <Link className="primary-link task-report-link" to={`${projectReviewsPath(projectId)}/${encodeURIComponent(item.runId)}`}>读取并核验报告<Icon name="chevron" size={15} /></Link> : null}</section> : null}
    </>
  );
}

