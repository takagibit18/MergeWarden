import { useEffect } from 'react';
import Button from 'antd/es/button';
import Form from 'antd/es/form';
import Select from 'antd/es/select';
import type { HistoryQuery, WorkspaceDto } from '@mergewarden/contracts';
import { statusLabels } from '../../shared/status';
import { filtersToQuery, scopeLabels } from './query-state';
import type { HistoryFilterValues } from './query-state';

const statusOptions = [{ value: '', label: '全部状态' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))];
const scopeOptions = [{ value: '', label: '全部范围' }, ...Object.entries(scopeLabels).map(([value, label]) => ({ value, label }))];

export function HistoryFilters({ query, workspaces, onApply }: { query: HistoryQuery; workspaces: WorkspaceDto[]; onApply: (query: HistoryQuery) => void }) {
  const [form] = Form.useForm<HistoryFilterValues>();
  useEffect(() => { form.setFieldsValue({ workspaceId: query.workspaceId ?? '', status: query.status ?? '', scope: query.scope ?? '' }); }, [form, query.workspaceId, query.status, query.scope]);

  return (
    <Form className="history-filters" form={form} layout="inline" onFinish={values => onApply(filtersToQuery(values, query.limit ?? 20))}>
      <Form.Item name="status" label="审查状态"><Select options={statusOptions} aria-label="审查状态" /></Form.Item>
      <Form.Item name="scope" label="审查范围"><Select options={scopeOptions} aria-label="审查范围" /></Form.Item>
      <Form.Item name="workspaceId" label="目录"><Select options={[{ value: '', label: '全部目录' }, ...workspaces.map(workspace => ({ value: workspace.id, label: `${workspace.name}${workspace.kind === 'primary' ? ' · 主目录' : ' · 工作树'}` }))]} aria-label="审查目录" /></Form.Item>
      <Form.Item><Button type="primary" htmlType="submit">应用筛选</Button></Form.Item>
      <Form.Item><Button type="text" htmlType="button" onClick={() => onApply({ limit: query.limit ?? 20 })}>重置</Button></Form.Item>
    </Form>
  );
}
