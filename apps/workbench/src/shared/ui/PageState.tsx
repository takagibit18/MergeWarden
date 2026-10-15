import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Empty from 'antd/es/empty';
import Skeleton from 'antd/es/skeleton';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function LoadingState({ label }: { label: string }) {
  return (
    <section className="surface state-surface" role="status" aria-label={label}>
      <span className="muted">{label}</span>
      <Skeleton active paragraph={{ rows: 4 }} />
    </section>
  );
}

export function ErrorState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <section className="surface state-surface" role="alert">
      <Alert type="error" showIcon message={title} description={description} />
      {onRetry ? <Button className="state-action" icon={<Icon name="refresh" size={16} />} onClick={onRetry}>重新读取</Button> : null}
    </section>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <section className="surface state-surface empty-surface">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><h3>{title}</h3><p className="muted">{description}</p></>} />
      {action ?? null}
    </section>
  );
}
