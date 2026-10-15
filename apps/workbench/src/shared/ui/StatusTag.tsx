import Tag from 'antd/es/tag';
import type { ReviewStatus, Severity } from '@mergewarden/contracts';
import { statusLabels } from '../status';

const severityLabels: Record<Severity, string> = { critical: '严重', high: '高', medium: '中', low: '低' };

export function StatusTag({ status }: { status: ReviewStatus | null }) {
  return <Tag className={`status-tag status-${status ?? 'unavailable'}`}>{status ? statusLabels[status] : '状态不可用'}</Tag>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <Tag className={`severity-tag severity-${severity}`}>严重程度 · {severityLabels[severity]}</Tag>;
}
