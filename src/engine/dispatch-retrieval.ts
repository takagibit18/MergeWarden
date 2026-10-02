import { DISPATCH_LIMITS } from "./dispatch-contracts.ts";
import type { ContextPackage, DispatchEntity, InvestigationRequest } from "./dispatch-contracts.ts";
import type { Relation, RelationFact } from "../graph/contracts.ts";
import { isObject } from "./tool-result.ts";

export type DispatchOperation = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const records = (x: unknown) => Array.isArray(x) ? x.filter(isObject) : [];
const definite = (r: Record<string, unknown>) => ["resolved_scoped", "resolved_import_alias"].includes(String(r.resolution));
export function exactEntity(value: Record<string, unknown>, request: InvestigationRequest): DispatchEntity | undefined {
  if (value.snapshotId !== request.snapshotId || typeof value.entityId !== "string" || typeof value.path !== "string"
    || typeof value.name !== "string" || typeof value.qualifiedName !== "string" || !["file", "class", "function"].includes(String(value.kind))
    || !Number.isInteger(value.startLine) || !Number.isInteger(value.endLine) || Number(value.startLine) < 1 || Number(value.endLine) < Number(value.startLine)) return;
  return value as unknown as DispatchEntity;
}
export async function retrieveStructure(request: InvestigationRequest, pack: ContextPackage, operation: DispatchOperation, collected: DispatchEntity[] = []): Promise<DispatchEntity[]> {
  if (!request.anchors.length) { pack.terminal = "anchor_missing"; return []; }
  const validate = (r: Record<string, unknown>) => {
    if (!["ok", "partial", "parse_incomplete", "unsupported"].includes(String(r.status))) throw Error("Graph unavailable: " + String(r.status));
    if (r.snapshotId !== request.snapshotId || r.revision !== "head" || typeof r.generationId !== "string"
      || pack.generationId && r.generationId !== pack.generationId) throw Error("Graph snapshot/generation mismatch");
    pack.generationId = r.generationId; request.generationId = r.generationId;
    if (r.status !== "ok" || r.truncated === true) pack.limitations.push("Graph coverage/output limited: " + String(r.status));
  };
  const located = await operation("locate_entity", { anchors: request.anchors }); validate(located);
  const entities = records(located.items).map(x => exactEntity(x, request)).filter((x): x is DispatchEntity => !!x)
    .filter(e => request.anchors.some(h => h.path === e.path && (!h.name || h.name === e.name)
      && (!h.qualifiedName || h.qualifiedName === e.qualifiedName) && (!h.kind || h.kind === e.kind)
      && (h.startLine === undefined || e.startLine <= h.startLine && e.endLine >= (h.endLine ?? h.startLine))));
  if (located.anchorStatus === "anchor_ambiguous" || located.truncated || entities.length > 1) { pack.terminal = "anchor_ambiguous"; return []; }
  if (entities.length !== 1) { pack.terminal = "anchor_missing"; return []; }
  const root = entities[0]!; pack.anchor = root;
  const found = new Map<string, DispatchEntity>();
  const walk = async (roots: DispatchEntity[], direction: "upstream" | "downstream" | "both", relations: Relation[], hops = 1) => {
    const r = await operation("traverse_graph", { startEntities: roots.map(e => e.entityId), direction, maxHops: hops,
      entityTypeFilter: [], relationTypeFilter: relations, maxNodes: DISPATCH_LIMITS.maxTraversalNodes, maxBytes: DISPATCH_LIMITS.maxTraversalBytes });
    validate(r);
    const edges = records(r.edges).filter(e => e.snapshotId === request.snapshotId && definite(e) && relations.includes(e.relation as Relation)) as unknown as RelationFact[];
    // Verify reachability using only returned definite edges, without inferring new relations.
    const reachable = new Set(roots.map(e => e.entityId));
    for (let n = 0; n < hops; n++) {
      const prior = new Set(reachable);
      for (const e of edges) {
        if ((direction === "downstream" || direction === "both") && prior.has(e.fromId)) reachable.add(e.toId);
        if ((direction === "upstream" || direction === "both") && prior.has(e.toId)) reachable.add(e.fromId);
      }
    }
    for (const edge of edges) if (reachable.has(edge.fromId) && reachable.has(edge.toId) && !pack.relations.some(e => e.id === edge.id)) pack.relations.push(edge);
    const result: DispatchEntity[] = [];
    for (const raw of records(r.items)) {
      const e = exactEntity(raw, request);
      if (!e || !reachable.has(e.entityId) || roots.some(x => x.entityId === e.entityId)) continue;
      if (!found.has(e.entityId) && e.entityId !== root.entityId) collected.push(e);
      found.set(e.entityId, e); result.push(e);
    }
    return result;
  };
  if (request.template === "CALLER_CHECK") await walk([root], "upstream", ["CALLS"]);
  else if (request.template === "INHERITANCE_CHECK") await walk([root], "both", ["INHERITS"]);
  else if (request.template === "IMPORT_CHECK") {
    const targets = await walk([root], "downstream", ["IMPORTS"]);
    const selected = targets.slice(0, DISPATCH_LIMITS.maxImportTargets);
    if (targets.length > selected.length) pack.omitted.push(`${targets.length - selected.length} export targets omitted by frozen root bound`);
    await walk([root, ...selected], "upstream", ["IMPORTS"]);
  } else await walk([root], "both", ["CALLS", "IMPORTS", "INHERITS"], DISPATCH_LIMITS.generalHops);
  return [...found.values()].filter(e => e.entityId !== root.entityId);
}
