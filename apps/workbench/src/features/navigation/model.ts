import type { NavigationEdgeDto, NavigationNodeDto, NavigationViewDto } from '@mergewarden/contracts';

export type RelationName = NavigationEdgeDto['relation'];
export const RELATIONS: RelationName[] = ['CALLS', 'IMPORTS', 'INHERITS', 'CONTAINS'];
export const relationLabels: Record<RelationName, string> = { CALLS: '调用', IMPORTS: '导入', INHERITS: '继承', CONTAINS: '包含' };
export const roleLabels: Record<NavigationNodeDto['roles'][number], string> = {
  change_root: '变更锚点', in_changed_file: '变更文件', evidence_overlap: '证据位置重叠', expanded: '已展开', candidate: '候选', visited: '已查看',
};
export const operationLabels = { graph_lookup: '查找实体', graph_neighbors: '查询关系', investigation_delivered: '宿主结构调查', candidate_expanded: '展开候选' } as const;

export interface NavigationFilter { relations: RelationName[]; stepSeq?: number | undefined }
export interface GraphGroup { id: string; path: string; fileNodeId?: string | undefined; children: NavigationNodeDto[] }
export interface GraphModel {
  groups: GraphGroup[];
  edges: (NavigationEdgeDto & { sourceId: string; targetId: string })[];
  /** Node ids shown or reached by the selected step; empty when no step is selected. */
  highlighted: Set<string>;
}

const byFirstSeen = (a: NavigationNodeDto, b: NavigationNodeDto) => (a.firstSeq ?? Number.MAX_SAFE_INTEGER) - (b.firstSeq ?? Number.MAX_SAFE_INTEGER) || a.startLine - b.startLine || (a.id < b.id ? -1 : 1);
export const groupId = (path: string) => `file:${path}`;

/**
 * Pure graph model for the canvas: one group per file (a file entity becomes its group header),
 * class/function nodes inside it, and only the relations the filter keeps. Directories are left out
 * of the drawing; CONTAINS between a file and its own members is implied by the grouping.
 */
export function navigationGraphModel(view: NavigationViewDto, filter: NavigationFilter): GraphModel {
  const groups = new Map<string, GraphGroup>(); const placement = new Map<string, string>();
  for (const node of [...view.nodes].sort(byFirstSeen)) {
    if (node.kind === 'directory') continue;
    let group = groups.get(node.path);
    if (!group) groups.set(node.path, group = { id: groupId(node.path), path: node.path, children: [] });
    if (node.kind === 'file') { group.fileNodeId = node.id; placement.set(node.id, group.id); }
    else { group.children.push(node); placement.set(node.id, node.id); }
  }
  const relations = new Set(filter.relations); const nodes = new Map(view.nodes.map(node => [node.id, node]));
  const edges = view.edges.flatMap(edge => {
    const sourceId = placement.get(edge.fromId), targetId = placement.get(edge.toId);
    if (!relations.has(edge.relation) || !sourceId || !targetId || sourceId === targetId) return [];
    if (edge.relation === 'CONTAINS' && nodes.get(edge.fromId)?.kind === 'file' && nodes.get(edge.toId)?.path === nodes.get(edge.fromId)?.path) return [];
    return [{ ...edge, sourceId, targetId }];
  });
  const highlighted = new Set<string>();
  const step = filter.stepSeq === undefined ? undefined : view.steps.find(item => item.seq === filter.stepSeq);
  if (step) {
    const edgeById = new Map(view.edges.map(edge => [edge.id, edge]));
    const mark = (id: string) => { const placed = placement.get(id); if (placed) highlighted.add(placed); };
    step.entityIds.forEach(mark);
    for (const id of step.relationIds) { const edge = edgeById.get(id); if (edge) { mark(edge.fromId); mark(edge.toId); } }
  }
  return { groups: [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)), edges, highlighted };
}

export function stepSummary(step: NavigationViewDto['steps'][number]): string {
  const input = step.input;
  if (step.op === 'graph_lookup') return `查找 “${String(input.query ?? '')}”，返回 ${step.entityIds.length} 个实体`;
  if (step.op === 'graph_neighbors') return `${input.direction === 'incoming' ? '入向' : '出向'} ${relationLabels[input.relation as RelationName] ?? String(input.relation ?? '')}，返回 ${step.relationIds.length} 条关系`;
  if (step.op === 'investigation_delivered') return `宿主调查（${String(input.routeType ?? '')}），${step.entityIds.length} 个实体、${step.relationIds.length} 条确定关系`;
  return `展开候选 ${step.candidateRefId ?? ''}`;
}
