import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Checkbox from 'antd/es/checkbox';
import Tag from 'antd/es/tag';
import { Link } from 'react-router-dom';
import type { NavigationNodeDto, NavigationResponse, NavigationViewDto } from '@mergewarden/contracts';
import { getNavigation, getNavigationSource } from '../../shared/api/navigation';
import { describeError } from '../../shared/api/client';
import { freshReadOptions } from '../../shared/api/query-options';
import { shortId } from '../../shared/presentation';
import { ErrorState, LoadingState } from '../../shared/ui/PageState';
import { SourceCodeViewer } from '../evidence/SourceCodeViewer';
import type { AvailableSource } from '../evidence/SourceCodeViewer';
import { navigationGraphModel, operationLabels, RELATIONS, relationLabels, roleLabels, stepSummary } from './model';
import type { RelationName } from './model';

const NavigationCanvas = lazy(() => import('./NavigationCanvas'));

/**
 * Read-only structural navigation of one delivered run (ADR 0021). Loaded only when opened, so
 * the report page makes no extra request and ships no graph code until the reviewer asks for it.
 */
export function NavigationSection({ projectId, runId, findingTitles }: { projectId: string; runId: string; findingTitles: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['project', projectId, 'navigation', runId], queryFn: ({ signal }) => getNavigation(projectId, runId, signal), enabled: open, ...freshReadOptions });
  return (
    <section className="surface navigation-surface" aria-label="结构导航">
      <div className="section-heading">
        <div><h2>结构导航</h2><span className="muted small">本次审查查看过的结构关系，只用于导航，证据以源码为准</span></div>
        <Button onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? '收起' : '查看结构导航'}</Button>
      </div>
      {!open ? null
        : query.isPending ? <LoadingState label="正在核验导航记录…" />
        : query.isError ? <ErrorState title="导航记录不可用" description={describeError(query.error)} onRetry={() => { void query.refetch(); }} />
        : <NavigationBody projectId={projectId} runId={runId} response={query.data} findingTitles={findingTitles} />}
    </section>
  );
}

function NavigationBody({ projectId, runId, response, findingTitles }: { projectId: string; runId: string; response: NavigationResponse; findingTitles: Record<string, string> }) {
  if (response.state === 'not_recorded') return <p className="muted navigation-message">本次运行没有导航记录：纯文本审查或早于导航记录的历史运行。</p>;
  if (response.state === 'unavailable' || !response.view) return <Alert className="navigation-message" type="warning" showIcon message="导航记录不可用" description={response.reason ?? '报告已交付，但导航记录没有保存。'} />;
  return <NavigationExplorer projectId={projectId} runId={runId} view={response.view} findingTitles={findingTitles} />;
}

function NavigationExplorer({ projectId, runId, view, findingTitles }: { projectId: string; runId: string; view: NavigationViewDto; findingTitles: Record<string, string> }) {
  const [relations, setRelations] = useState<RelationName[]>(['CALLS', 'IMPORTS', 'INHERITS']);
  const [stepSeq, setStepSeq] = useState<number | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const model = useMemo(() => navigationGraphModel(view, { relations, stepSeq }), [relations, stepSeq, view]);
  const entities = useMemo(() => view.nodes.filter(node => node.kind !== 'directory'), [view.nodes]);
  const selected = entities.find(node => node.id === selectedId);
  if (!view.steps.length) return <p className="muted navigation-message">本次审查启用了结构导航，但没有使用图工具。</p>;
  return (
    <div className="navigation-body">
      <div className="navigation-summary"><span>{view.steps.length} 步</span><span>{entities.length} 个实体</span><span>{view.edges.length} 条关系</span>
        {view.generationIds.map(id => <span key={id} className="mono muted" title={id}>图版本 {shortId(id, 12)}</span>)}</div>
      {view.truncated || !view.entityFactsComplete || view.limitations.length ? (
        <Alert className="navigation-limits" type="warning" showIcon message="导航记录不完整" description={<ul>{[
          ...(view.truncated ? ['记录达到上限，之后的导航未保存。'] : []), ...(!view.entityFactsComplete ? ['部分实体无法从图中描述，相关关系未绘制。'] : []), ...view.limitations,
        ].map(item => <li key={item}>{item}</li>)}</ul>} />
      ) : null}
      <div className="navigation-filters">
        <Checkbox.Group aria-label="关系类型" value={relations} onChange={values => setRelations(values as RelationName[])}
          options={RELATIONS.map(value => ({ value, label: relationLabels[value] }))} />
        {stepSeq !== undefined ? <Button size="small" onClick={() => setStepSeq(undefined)}>取消步骤高亮</Button> : null}
      </div>
      <div className="navigation-layout">
        <ol className="navigation-steps" aria-label="导航步骤">
          {view.steps.map(step => (
            <li key={step.seq}>
              <button type="button" className={`navigation-step${step.seq === stepSeq ? ' is-selected' : ''}`} aria-pressed={step.seq === stepSeq} onClick={() => setStepSeq(step.seq === stepSeq ? undefined : step.seq)}>
                <span className="navigation-step-heading"><span className="mono">#{step.seq}</span><strong>{operationLabels[step.op]}</strong>{step.origin === 'host_dispatch' ? <Tag>宿主</Tag> : null}
                  {step.status !== 'ok' && step.status !== 'context_returned' ? <Tag color="warning">{step.status}</Tag> : null}</span>
                <span className="muted small">{stepSummary(step)}</span>
                {step.coverageLimited || step.pageTruncated ? <span className="muted small">结果可能不完整；空结果不代表不存在</span> : null}
                {step.error ? <span className="small navigation-error">{step.error}</span> : null}
              </button>
            </li>
          ))}
        </ol>
        <div className="navigation-graph">
          <Suspense fallback={<p className="muted nav-canvas-message" role="status">正在加载图组件…</p>}>
            <NavigationCanvas model={model} nodes={entities} selectedId={selectedId} onSelect={setSelectedId} />
          </Suspense>
        </div>
        <div className="navigation-side">
          <ul className="navigation-entities" aria-label="实体列表">
            {entities.map(node => (
              <li key={node.id}><button type="button" className={`navigation-entity${node.id === selectedId ? ' is-selected' : ''}${model.highlighted.size && !model.highlighted.has(node.kind === 'file' ? `file:${node.path}` : node.id) ? ' is-dimmed' : ''}`}
                aria-pressed={node.id === selectedId} onClick={() => setSelectedId(node.id)}>
                <span className="mono small">{node.kind === 'file' ? node.path : `${node.name}`}</span>
                <span className="muted small">{node.kind === 'file' ? '文件' : `${node.path}:${node.startLine}`}</span>
              </button></li>
            ))}
          </ul>
          {selected ? <EntityDetail projectId={projectId} runId={runId} node={selected} findingTitles={findingTitles} /> : <p className="muted small">选择一个实体查看位置与源码。</p>}
        </div>
      </div>
    </div>
  );
}

function EntityDetail({ projectId, runId, node, findingTitles }: { projectId: string; runId: string; node: NavigationNodeDto; findingTitles: Record<string, string> }) {
  const [showSource, setShowSource] = useState(false);
  const source = useQuery({ queryKey: ['project', projectId, 'navigation', runId, 'source', node.id], queryFn: ({ signal }) => getNavigationSource(projectId, runId, node.id, signal), enabled: showSource, ...freshReadOptions });
  return (
    <section className="navigation-detail" aria-label="所选实体">
      <h3 className="mono">{node.qualifiedName || node.name}</h3>
      <p className="muted small mono">{node.path}:{node.startLine}–{node.endLine}</p>
      <div className="navigation-roles">{node.roles.map(role => <Tag key={role}>{roleLabels[role]}</Tag>)}</div>
      {node.findingIds.length ? <div className="navigation-findings"><span className="muted small">证据位置重叠的问题（不代表由图发现）</span>
        <ul>{node.findingIds.map(id => <li key={id}><Link to={`?${new URLSearchParams({ finding: id })}`}>{findingTitles[id] ?? id}</Link></li>)}</ul></div> : null}
      <Button size="small" onClick={() => setShowSource(value => !value)} aria-expanded={showSource}>{showSource ? '收起源码' : '查看 HEAD 源码'}</Button>
      {showSource ? source.isPending ? <p className="muted small" role="status">正在读取冻结源码…</p>
        : source.isError ? <Alert type="error" showIcon message="源码不可用" description={describeError(source.error)} />
        : source.data.source.status === 'ok' ? <SourceCodeViewer source={source.data.source as AvailableSource} evidence={false} />
        : <Alert type="warning" showIcon message="源码不可用" description={source.data.source.warnings.join('；') || '冻结快照中没有可读文本。'} /> : null}
    </section>
  );
}
