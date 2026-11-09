import type { NavigationNodeDto, NavigationViewDto } from '../../../packages/contracts/src/types.ts';

/** Mermaid labels are quoted; these characters would break the quoted form or inject markup. */
const label = (value: string) => value.replace(/["`<>]/g, character => `#${character.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ').slice(0, 120);
const order = (a: NavigationNodeDto, b: NavigationNodeDto) => (a.firstSeq ?? Number.MAX_SAFE_INTEGER) - (b.firstSeq ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Deterministic Mermaid flowchart of a navigation view (ADR 0021). Files become subgraphs; only
 * resolved/definite relations are drawn solid, candidate ones dotted. Large views keep the
 * earliest-visited nodes and say how many were left out.
 */
export function navigationMermaid(view: NavigationViewDto, options: { maxNodes?: number } = {}): string {
  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 60, 500));
  const nodes = view.nodes.filter(node => node.kind !== 'directory').sort(order);
  const kept = nodes.slice(0, maxNodes); const ids = new Map(kept.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart LR'];
  const byFile = new Map<string, NavigationNodeDto[]>();
  for (const node of kept) { const list = byFile.get(node.path) ?? []; list.push(node); byFile.set(node.path, list); }
  let group = 0;
  for (const path of [...byFile.keys()].sort()) {
    lines.push(`  subgraph g${group++}["${label(path)}"]`);
    for (const node of byFile.get(path)!) {
      const text = node.kind === 'file' ? node.name : `${node.kind === 'class' ? 'class ' : ''}${node.name} L${node.startLine}`;
      lines.push(`    ${ids.get(node.id)}["${label(text)}"]`);
    }
    lines.push('  end');
  }
  const edges = view.edges.filter(edge => ids.has(edge.fromId) && ids.has(edge.toId))
    .sort((a, b) => (a.firstSeq ?? Number.MAX_SAFE_INTEGER) - (b.firstSeq ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1));
  for (const edge of edges) {
    const arrow = edge.resolution === 'candidate' || edge.resolution === 'unresolved' ? '-.->' : '-->';
    lines.push(`  ${ids.get(edge.fromId)} ${arrow}|${edge.relation}| ${ids.get(edge.toId)}`);
  }
  const classes: [string, (node: NavigationNodeDto) => boolean, string][] = [
    ['changeRoot', node => node.roles.includes('change_root') || node.roles.includes('in_changed_file'), 'stroke-width:2px,stroke-dasharray:0'],
    ['evidence', node => node.roles.includes('evidence_overlap'), 'stroke-width:3px'],
  ];
  for (const [name, test, style] of classes) {
    const members = kept.filter(test).map(node => ids.get(node.id)!);
    if (members.length) lines.push(`  classDef ${name} ${style}`, `  class ${members.join(',')} ${name}`);
  }
  if (nodes.length > kept.length) lines.push(`  %% ${nodes.length - kept.length} more node(s) omitted`);
  return lines.join('\n') + '\n';
}
