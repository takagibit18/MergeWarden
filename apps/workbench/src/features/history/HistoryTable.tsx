import { Link } from 'react-router-dom';
import type { HistoryItem, WorkspaceDto } from '@mergewarden/contracts';
import { formatDate, reviewTitle } from '../../shared/presentation';
import { Icon } from '../../shared/ui/Icon';
import { StatusTag } from '../../shared/ui/StatusTag';
import { scopeLabels } from './query-state';
import { CopyValue } from '../../shared/ui/CopyValue';

export function HistoryTable({ projectId, items, workspaces = [] }: { projectId: string; items: HistoryItem[]; workspaces?: WorkspaceDto[] }) {
  return (
    <div className="history-table">
      <div className="history-table-header" aria-hidden="true"><span>审查记录</span><span>范围</span><span>结果状态</span><span>报告</span><span className="history-count-heading">问题</span><span>创建时间</span><span /></div>
      <ul className="history-records" aria-label="审查记录列表">
        {items.map(item => (
          <li className="history-row" key={item.id}>
            <div className="review-cell">
              <Icon name="file" size={18} />
              <div className="review-cell-content"><span className="review-cell-title" title={reviewTitle(item)}>{reviewTitle(item)}</span><span className="muted review-cell-model" title={item.model ? `${item.model.provider} / ${item.model.modelId}` : undefined}>{item.model ? `${item.model.provider} / ${item.model.modelId}` : '模型未记录'}{item.workspaceId ? <span className="record-workspace"> · {workspaces.find(workspace => workspace.id === item.workspaceId)?.name ?? '已登记目录'}</span> : null}</span><CopyValue value={item.runId ?? item.taskId ?? item.id} label="记录 ID" /></div>
            </div>
            <div className="history-row-meta">
              <span className="history-record-scope">{item.scope ? scopeLabels[item.scope] : <span className="muted">范围未记录</span>}</span>
              <span className="history-record-status"><StatusTag status={item.status} /></span>
              <span className={`history-record-delivery${item.reportAvailability === 'verified' ? ' delivery-ok' : ' muted'}`}>{item.reportAvailability === 'verified' ? <><Icon name="check" size={13} />索引已核验</> : item.reportAvailability === 'not_delivered' ? '未确认交付' : '产物不可用'}</span>
              <span className="history-record-count"><span className="compact-cell-label">问题 </span><span className="count-value">{item.findingCount ?? '—'}</span></span>
              <time className="history-record-date" dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </div>
            <span className="history-record-action"><HistoryAction projectId={projectId} item={item} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryAction({ projectId, item }: { projectId: string; item: HistoryItem }) {
  const basePath = `/projects/${encodeURIComponent(projectId)}`;
  if (item.reportAvailability === 'not_delivered' && (item.taskId ?? item.runId)) {
    return <Link className="table-link" to={`${basePath}/tasks/${encodeURIComponent((item.taskId ?? item.runId)!)}`}>任务<Icon name="chevron" size={13} /></Link>;
  }
  if (item.runId) return <Link className="table-link" to={`${basePath}/reviews/${encodeURIComponent(item.runId)}`}>详情<Icon name="chevron" size={13} /></Link>;
  if (item.taskId) return <Link className="table-link" to={`${basePath}/tasks/${encodeURIComponent(item.taskId)}`}>任务<Icon name="chevron" size={13} /></Link>;
  return <span className="muted">不可用</span>;
}
