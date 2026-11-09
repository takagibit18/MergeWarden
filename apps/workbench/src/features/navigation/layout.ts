import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { GraphModel } from './model';

export const NODE_WIDTH = 220, NODE_HEIGHT = 44, GROUP_HEADER = 36, GROUP_PADDING = 12;
export interface Placed { id: string; x: number; y: number; width: number; height: number; parentId?: string | undefined }

const elk = new ELK();

/** Layered left-to-right layout; files are compound nodes so members stay inside their file. */
export async function layoutGraph(model: GraphModel): Promise<Placed[]> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '24', 'elk.layered.spacing.nodeNodeBetweenLayers': '64', 'elk.edgeRouting': 'ORTHOGONAL' },
    children: model.groups.map(group => ({
      id: group.id,
      layoutOptions: { 'elk.padding': `[top=${GROUP_HEADER},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]` },
      ...(group.children.length ? { children: group.children.map(node => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })) } : { width: NODE_WIDTH, height: GROUP_HEADER + GROUP_PADDING }),
    })),
    edges: model.edges.map(edge => ({ id: edge.id, sources: [edge.sourceId], targets: [edge.targetId] })),
  };
  const result = await elk.layout(graph);
  const placed: Placed[] = [];
  for (const group of result.children ?? []) {
    placed.push({ id: group.id, x: group.x ?? 0, y: group.y ?? 0, width: group.width ?? NODE_WIDTH, height: group.height ?? NODE_HEIGHT });
    for (const child of group.children ?? []) placed.push({ id: child.id, parentId: group.id, x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? NODE_WIDTH, height: child.height ?? NODE_HEIGHT });
  }
  return placed;
}
