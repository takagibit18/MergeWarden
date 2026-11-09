import type { NavigationEdgeDto, NavigationNodeDto, NavigationNodeRole, NavigationStepDto, NavigationViewDto, ReportDto } from '../../../packages/contracts/src/types.ts';
import { NAVIGATION_LIMITS, NAVIGATION_VERSION } from '../../engine/navigation-contracts.ts';
import type { NavigationRecord } from '../../engine/navigation-contracts.ts';
import { isRecord } from '../../domain/validation.ts';

const KINDS = new Set(['directory', 'file', 'class', 'function']);
const RELATIONS = new Set(['CONTAINS', 'IMPORTS', 'CALLS', 'INHERITS']);
const RESOLUTIONS = new Set(['resolved_scoped', 'resolved_import_alias', 'candidate', 'unresolved', 'definite']);
const OPERATIONS = new Set(['graph_lookup', 'graph_neighbors', 'investigation_delivered', 'candidate_expanded']);
const ROLE_ORDER: NavigationNodeRole[] = ['change_root', 'in_changed_file', 'evidence_overlap', 'expanded', 'candidate', 'visited'];
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const isLine = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
/** Directory entities carry no source span: the graph stores them with lines 0..0. */
const validSpan = (kind: string, start: unknown, end: unknown) => kind === 'directory' ? start === 0 && end === 0 : isLine(start) && isLine(end) && end >= start;
const isText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const ids = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(isId);
const optionalText = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max);
const validChangeUnit = (unit: unknown) => isRecord(unit) && isId(unit.changeUnitId) && isText(unit.path, 4096) && isText(unit.kind, 16) && isText(unit.resolution, 64)
  && (unit.entityId === undefined || isId(unit.entityId));
const validInvestigation = (item: unknown) => isRecord(item) && isId(item.investigationId) && isText(item.routeType, 64) && isText(item.status, 64)
  && Array.isArray(item.changeUnits) && item.changeUnits.length <= 64 && item.changeUnits.every(validChangeUnit) && ids(item.candidateRefIds, 500)
  && Array.isArray(item.limitations) && item.limitations.length <= 16 && item.limitations.every(text => isText(text, 512));

/**
 * Structural validation of a native navigation record against its run and frozen snapshot.
 * Throws on any mismatch; the caller turns that into an integrity error.
 */
export function validateNavigation(value: unknown, expected: { runId: string; snapshotId: string; headPaths: string[] }): NavigationRecord {
  if (!isRecord(value) || value.version !== NAVIGATION_VERSION || value.runId !== expected.runId || value.snapshotId !== expected.snapshotId) throw new Error('Navigation identity mismatch');
  if (!['text-only', 'text+graph', 'text+locagent'].includes(String(value.toolExposure)) || typeof value.truncated !== 'boolean' || typeof value.entityFactsComplete !== 'boolean') throw new Error('Invalid navigation header');
  if (!ids(value.generationIds, 16) || !Array.isArray(value.limitations) || value.limitations.length > 16 || !value.limitations.every(item => isText(item, 512))) throw new Error('Invalid navigation header');
  const { steps, entities, relations, candidates } = value;
  if (!Array.isArray(steps) || steps.length > NAVIGATION_LIMITS.maxSteps || !Array.isArray(entities) || entities.length > NAVIGATION_LIMITS.maxEntities
    || !Array.isArray(relations) || relations.length > NAVIGATION_LIMITS.maxRelations || !Array.isArray(candidates)) throw new Error('Navigation exceeds its limits');
  const files = new Set(expected.headPaths); const entityIds = new Set<string>();
  const inHead = (kind: string, path: string) => kind === 'directory' ? path === '/' || expected.headPaths.some(item => item.startsWith(path + '/')) : files.has(path);
  for (const entity of entities) {
    if (!isRecord(entity) || !isId(entity.id) || !KINDS.has(String(entity.kind)) || !isText(entity.path, 4096) || !entity.path || !isText(entity.qualifiedName, 4096) || !isText(entity.name, 1024)
      || !validSpan(String(entity.kind), entity.startLine, entity.endLine)) throw new Error('Invalid navigation entity');
    if (!inHead(String(entity.kind), String(entity.path))) throw new Error('Navigation entity is outside the frozen head');
    if (entityIds.has(entity.id)) throw new Error('Duplicate navigation entity'); entityIds.add(entity.id);
  }
  const relationIds = new Set<string>();
  for (const relation of relations) {
    if (!isRecord(relation) || !isId(relation.id) || !isId(relation.fromId) || !isId(relation.toId) || !RELATIONS.has(String(relation.relation)) || !RESOLUTIONS.has(String(relation.resolution))
      || !['graph_neighbors', 'host_investigation'].includes(String(relation.origin))) throw new Error('Invalid navigation relation');
    if (relationIds.has(relation.id)) throw new Error('Duplicate navigation relation'); relationIds.add(relation.id);
  }
  let previous = 0;
  for (const step of steps) {
    if (!isRecord(step) || !Number.isInteger(step.seq) || (step.seq as number) <= previous || !OPERATIONS.has(String(step.op)) || !['model_tool', 'host_dispatch'].includes(String(step.origin))
      || !isText(step.status, 64) || typeof step.coverageLimited !== 'boolean' || typeof step.pageTruncated !== 'boolean' || !isRecord(step.input)
      || !ids(step.entityIds, 5000) || !ids(step.relationIds, 5000)
      || !optionalText(step.error, 512) || !optionalText(step.requestId, 160) || !optionalText(step.candidateRefId, 80) || !optionalText(step.terminal, 64) || !optionalText(step.generationId, 160)
      || (step.investigations !== undefined && (!Array.isArray(step.investigations) || step.investigations.length > 32 || !step.investigations.every(validInvestigation)))) throw new Error('Invalid navigation step');
    previous = step.seq as number;
    if (!value.truncated && (step.entityIds.some(id => !entityIds.has(id)) || step.relationIds.some(id => !relationIds.has(id)))) throw new Error('Navigation step references unknown facts');
  }
  for (const candidate of candidates) if (!isRecord(candidate) || !isId(candidate.candidateRefId) || !isId(candidate.entityId) || !ids(candidate.rootChangeUnitIds, 64)) throw new Error('Invalid navigation candidate');
  return value as unknown as NavigationRecord;
}

const overlaps = (a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }) => a.startLine <= b.endLine && b.startLine <= a.endLine;
const scalarInput = (input: Record<string, unknown>): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 256) : item]));

/**
 * People-facing view of a verified record. Roles are deterministic facts about location and
 * navigation order; `evidence_overlap` is location overlap with head evidence, never attribution.
 */
export function projectNavigation(record: NavigationRecord, report: ReportDto, changedPaths: string[]): NavigationViewDto {
  const changed = new Set(changedPaths); const roles = new Map<string, Set<NavigationNodeRole>>(); const firstSeq = new Map<string, number>();
  const role = (id: string, value: NavigationNodeRole) => { let set = roles.get(id); if (!set) roles.set(id, set = new Set()); set.add(value); };
  const seen = (id: string, seq: number) => { if (!firstSeq.has(id)) firstSeq.set(id, seq); };
  const relationById = new Map(record.relations.map(relation => [relation.id, relation]));
  for (const step of record.steps) {
    for (const id of step.entityIds) { seen(id, step.seq); role(id, 'visited'); }
    for (const id of step.relationIds) { seen(id, step.seq); const relation = relationById.get(id); if (relation) { seen(relation.fromId, step.seq); seen(relation.toId, step.seq); role(relation.fromId, 'visited'); role(relation.toId, 'visited'); } }
    if (step.op === 'candidate_expanded') for (const id of step.entityIds) role(id, 'expanded');
    for (const investigation of step.investigations ?? []) for (const unit of investigation.changeUnits) if (unit.entityId) role(unit.entityId, 'change_root');
  }
  for (const candidate of record.candidates) role(candidate.entityId, 'candidate');
  const findings = [...report.findings, ...report.knownAccepted ?? []];
  const nodes: NavigationNodeDto[] = record.entities.map(entity => {
    if (changed.has(entity.path)) role(entity.id, 'in_changed_file');
    const findingIds = findings.filter(finding => finding.evidence.some(ref => ref.revision === 'head' && ref.path === entity.path
      && (entity.kind === 'file' || overlaps(ref, entity)))).map(finding => finding.id);
    if (findingIds.length && entity.kind !== 'directory') role(entity.id, 'evidence_overlap');
    const set = roles.get(entity.id) ?? new Set();
    return { id: entity.id, kind: entity.kind, ...(entity.functionKind ? { functionKind: entity.functionKind } : {}), path: entity.path, qualifiedName: entity.qualifiedName,
      name: entity.name, startLine: entity.startLine, endLine: entity.endLine, roles: ROLE_ORDER.filter(item => set.has(item)), findingIds, firstSeq: firstSeq.get(entity.id) ?? null };
  });
  const known = new Set(nodes.map(node => node.id)); const limitations = [...record.limitations];
  const edges: NavigationEdgeDto[] = record.relations.filter(relation => known.has(relation.fromId) && known.has(relation.toId))
    .map(relation => ({ id: relation.id, fromId: relation.fromId, toId: relation.toId, relation: relation.relation, resolution: relation.resolution, origin: relation.origin, firstSeq: firstSeq.get(relation.id) ?? null }));
  const omitted = record.relations.length - edges.length;
  if (omitted) limitations.push(`${omitted} recorded relation(s) are not drawn because an endpoint entity could not be described.`);
  if (record.truncated) limitations.push('The navigation record reached a step, entity or relation limit; later navigation is not shown.');
  const steps: NavigationStepDto[] = record.steps.map(step => ({ seq: step.seq, origin: step.origin, op: step.op, input: scalarInput(step.input), status: step.status,
    coverageLimited: step.coverageLimited, pageTruncated: step.pageTruncated, entityIds: [...step.entityIds], relationIds: [...step.relationIds],
    ...(step.error ? { error: step.error } : {}), ...(step.requestId ? { requestId: step.requestId } : {}),
    ...(step.candidateRefId ? { candidateRefId: step.candidateRefId } : {}), ...(step.terminal ? { terminal: step.terminal } : {}) }));
  return { toolExposure: record.toolExposure, generationIds: [...record.generationIds], truncated: record.truncated, entityFactsComplete: record.entityFactsComplete,
    limitations: limitations.slice(0, 16), nodes, edges, steps };
}
