import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NavigationNodeDto } from '@mergewarden/contracts';
import { layoutGraph } from './layout';
import type { Placed } from './layout';
import { relationLabels } from './model';
import type { GraphModel } from './model';

interface Props { model: GraphModel; nodes: NavigationNodeDto[]; selectedId?: string | undefined; onSelect: (entityId: string) => void }

/** Lazily loaded canvas: React Flow renders, ELK lays out. It only displays the verified model. */
export default function NavigationCanvas({ model, nodes, selectedId, onSelect }: Props) {
  const [placed, setPlaced] = useState<Placed[] | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; setFailed(false);
    layoutGraph(model).then(result => { if (live) setPlaced(result); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [model]);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const dimmed = model.highlighted.size > 0;

  const flowNodes = useMemo<Node[]>(() => (placed ?? []).map(item => {
    const group = model.groups.find(candidate => candidate.id === item.id);
    const entity = group ? (group.fileNodeId ? byId.get(group.fileNodeId) : undefined) : byId.get(item.id);
    const entityId = group ? group.fileNodeId : item.id;
    const classes = ['nav-node', group ? 'nav-group' : `nav-${entity?.kind ?? 'node'}`,
      ...(entity?.roles ?? []).map(role => `nav-role-${role}`),
      entityId && entityId === selectedId ? 'is-selected' : '', dimmed && !model.highlighted.has(item.id) ? 'is-dimmed' : ''].filter(Boolean);
    const label = group ? group.path : `${entity?.kind === 'class' ? 'class ' : ''}${entity?.name ?? item.id} · L${entity?.startLine ?? ''}`;
    return { id: item.id, position: { x: item.x, y: item.y }, ...(item.parentId ? { parentId: item.parentId, extent: 'parent' as const } : {}),
      data: { label, entityId }, className: classes.join(' '), style: { width: item.width, height: item.height }, draggable: false, connectable: false,
      ariaLabel: group ? `文件 ${group.path}` : `${entity?.qualifiedName ?? item.id}` };
  }), [byId, dimmed, model, placed, selectedId]);

  const flowEdges = useMemo<Edge[]>(() => model.edges.map(edge => ({
    id: edge.id, source: edge.sourceId, target: edge.targetId, label: relationLabels[edge.relation],
    className: `nav-edge nav-edge-${edge.relation.toLowerCase()} ${edge.resolution === 'candidate' || edge.resolution === 'unresolved' ? 'is-candidate' : ''}`,
    markerEnd: { type: MarkerType.ArrowClosed }, animated: false,
  })), [model.edges]);

  const select: NodeMouseHandler = (_event, node) => { const entityId = (node.data as { entityId?: string }).entityId; if (entityId) onSelect(entityId); };
  if (failed) return <p className="muted nav-canvas-message" role="status">布局计算失败，可改用左侧实体列表浏览。</p>;
  if (!placed) return <p className="muted nav-canvas-message" role="status">正在计算布局…</p>;
  return (
    <div className="nav-canvas" aria-label="结构导航图">
      <ReactFlow nodes={flowNodes} edges={flowEdges} onNodeClick={select} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable minZoom={0.2}>
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
