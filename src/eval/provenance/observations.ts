import type { EvidenceRef, FindingCandidate } from "../../domain/contracts.ts";
import { isObject } from "../../engine/tool-result.ts";
import { decodePiTrace, issue, type ToolCall, type TraceIssue } from "./decode.ts";
import { normalizeSubmittedFindings } from "./submission.ts";

export const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(isObject) : [];
export const end = (c: ToolCall) => c.resultEvent ?? Infinity;
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export const isGraph = (c: ToolCall) => ["graph_lookup", "graph_neighbors", "search_entity", "traverse_graph"].includes(c.name);
export const usable = (c: ToolCall, snapshot: string) => c.argumentsValid !== false && !c.isError && c.response?.snapshotId === snapshot && ["ok", "parse_incomplete", "partial"].includes(String(c.response.status));
export const coverageLimited = (c: ToolCall) => ["partial", "parse_incomplete"].includes(String(c.response?.status)) || c.response?.generationState === "partial" || (isObject(c.response?.coverage) && c.response.coverage.generationState === "partial") || c.response?.truncated === true;
const definite = (resolution: unknown) => ["resolved_scoped", "resolved_import_alias"].includes(String(resolution));
const hintItems = (c: ToolCall) => rows(c.response?.hints).flatMap(h => rows(h.candidates));
/** Visible exposure is broader than usable proof: even a returned candidate removes novelty. */
export function exposesPath(c: ToolCall, path: string, snapshot: string): boolean {
  if (c.response?.snapshotId !== snapshot) return false;
  if (["read_source", "read_diff"].includes(c.name)) return c.response.path === path;
  if (!["search_text", "search_entity", "traverse_graph", "graph_lookup", "graph_neighbors"].includes(c.name)) return false;
  return [...rows(c.response.items), ...hintItems(c)].some(i => i.path === path || i.sourcePath === path);
}
export function exposesEntity(c: ToolCall, id: string, snapshot: string): boolean {
  return c.response?.snapshotId === snapshot && isGraph(c) && [...rows(c.response.items), ...hintItems(c)].some(i => [i.id, i.entityId, i.fromId, i.toId].includes(id));
}
export interface Location {
  id: string; path: string; startLine: number; endLine: number; depth: number;
  mode: "entity_search" | "traversal"; assistanceKind: string; strictCaller: boolean;
  edgeId: string; resolution: string; via: Record<string, unknown>;
}
/** Graph adapters interpret only visible fields; never consult a graph DB or host details. */
export function locations(c: ToolCall, snapshot: string): Location[] {
  if (!isGraph(c) || !usable(c, snapshot) || (c.response?.revision !== undefined && c.response.revision !== "head")) return [];
  return rows(c.response?.items).flatMap(i => {
    if (i.snapshotId !== undefined && i.snapshotId !== snapshot) return [];
    let id = i.entityId ?? i.id, path = i.path, startLine = i.startLine, endLine = i.endLine;
    let via: Record<string, unknown> = {}, depth = 0, mode: Location["mode"] = "entity_search";
    if (c.name === "traverse_graph") {
      if (!(Number(i.depth) > 0) || !isObject(i.discoveredVia)) return [];
      via = i.discoveredVia; depth = Number(i.depth); mode = "traversal";
      if (via.pathResolved !== true || !definite(via.resolution) || typeof via.edgeId !== "string") return [];
      if (!["upstream", "downstream"].includes(String(via.direction)) || (c.args.direction !== "both" && c.args.direction !== via.direction)) return [];
    } else if (c.name === "graph_neighbors") {
      // G0 returns edge source locations, not the outgoing target's location.
      if (c.args.direction !== "incoming" || i.snapshotId !== snapshot || typeof i.id !== "string" || i.toId !== c.args.symbolId || i.relation !== c.args.relation || !definite(i.resolution)) return [];
      id = i.fromId; path = i.sourcePath; startLine = i.sourceLine; endLine = i.sourceEndLine; depth = 1; mode = "traversal";
      via = { edgeId: i.id, relation: i.relation, resolution: i.resolution, direction: "upstream", pathResolved: true };
    }
    if (mode === "traversal" && !["CALLS", "IMPORTS", "INHERITS", "CONTAINS"].includes(String(via.relation))) return [];
    if (typeof id !== "string" || typeof path !== "string" || !Number.isInteger(startLine) || Number(startLine) < 1 || !Number.isInteger(endLine) || Number(endLine) < Number(startLine)) return [];
    const strictCaller = mode === "traversal" && depth === 1 && via.direction === "upstream" && via.relation === "CALLS";
    const assistanceKind = mode === "entity_search" ? "entity_search" : depth > 1 ? "multi_hop" : via.relation === "CALLS" ? via.direction === "upstream" ? "incoming_call" : "outgoing_call" : via.relation === "INHERITS" ? "inheritance" : via.relation === "IMPORTS" ? "import" : "containment";
    return [{ id, path, startLine: Number(startLine), endLine: Number(endLine), depth, mode, assistanceKind, strictCaller, edgeId: String(via.edgeId ?? ""), resolution: String(via.resolution ?? ""), via }];
  });
}
export const evidenceFields = ["snapshotId", "revision", "path", "startLine", "endLine", "contentSha256"] as const;
export function sourceMatches(c: ToolCall, e: EvidenceRef, snapshot: string): boolean {
  return c.name === "read_source" && usable(c, snapshot) && c.response?.status === "ok" && e.snapshotId === snapshot && evidenceFields.every(k => c.response?.[k] === e[k]);
}
export function sourceCovers(c: ToolCall, loc: Pick<Location, "path" | "startLine" | "endLine">, snapshot: string): boolean {
  return c.name === "read_source" && usable(c, snapshot) && c.response?.status === "ok" && c.response.revision === "head" && c.response.path === loc.path && Number(c.response.startLine) <= loc.startLine && Number(c.response.endLine) >= loc.endLine;
}
export function novelty(calls: ToolCall[], c: ToolCall, loc: {id: string; path: string}, snapshot: string) {
  const earlier = calls.filter(p => end(p) < end(c));
  const novelPath = !earlier.some(p => exposesPath(p, loc.path, snapshot));
  return { novelPath, novelEntity: novelPath && !earlier.some(p => exposesEntity(p, loc.id, snapshot)) };
}
export interface ProvenanceInput { runKey: string; snapshotId: string; findings: FindingCandidate[]; jsonl: string; changedPaths?: readonly string[] }
export function observe(input: ProvenanceInput) {
  const trace = decodePiTrace(input.jsonl), calls = trace.calls, snapshot = input.snapshotId;
  for (const c of calls) {
    if (c.isError || c.response?.status === "error") trace.issues.push(issue(c.name === "submit_review" ? "submission_validation_failure" : "tool_error", "Tool returned an error", c.id));
    if (c.response?.snapshotId !== undefined && c.response.snapshotId !== snapshot || rows(c.response?.items).some(i => i.snapshotId !== undefined && i.snapshotId !== snapshot)) trace.issues.push(issue("cross_snapshot", `Cross-snapshot model-visible result: ${c.id}`));
  }
  // Change membership is business context, not discovery credit. A later diff still
  // proves that a Graph-first location was changed, so it cannot count as untouched.
  const changedPaths = new Set(input.changedPaths ?? []);
  for (const c of calls) {
    if (c.name === "read_diff" && usable(c, snapshot) && typeof c.response?.path === "string") changedPaths.add(c.response.path);
    if (c.name === "submit_review" && !c.isError && c.response?.accepted === true && Array.isArray(c.args.reviewedPaths)) for (const path of c.args.reviewedPaths) if (typeof path === "string") changedPaths.add(path);
  }
  const discoveries = calls.flatMap(c => locations(c, snapshot).map(location => ({ graphCall: c, location, ...novelty(calls, c, location, snapshot), coverageLimited: coverageLimited(c) })));
  const sourceLinks = discoveries.flatMap(d => calls.filter(c => c.callEvent > end(d.graphCall) && sourceCovers(c, d.location, snapshot)).map(source => ({ ...d, sourceCall: source, strictNovel: d.novelPath && d.novelEntity && !changedPaths.has(d.location.path) })));
  const findings = input.findings.map(finding => {
    const submission = calls.findLast(c => c.name === "submit_review" && !c.isError && c.response?.accepted === true && (c.response.snapshotId === undefined || c.response.snapshotId === snapshot) && normalizeSubmittedFindings(c, calls, snapshot).some(f => canonical(f) === canonical(finding)));
    const reads = finding.evidence.map(e => calls.find(c => sourceMatches(c, e, snapshot) && end(c) < (submission?.callEvent ?? -1)));
    const chains = sourceLinks.filter(l => finding.evidence.some(e => sourceMatches(l.sourceCall, e, snapshot)) && end(l.sourceCall) < (submission?.callEvent ?? -1)).map(l => ({
      graphCallId: l.graphCall.id, neighborCallId: l.graphCall.id, neighborToolOrdinal: l.graphCall.ordinal, neighborEntryId: l.graphCall.resultEntryId!,
      sourceCallId: l.sourceCall.id, sourceToolOrdinal: l.sourceCall.ordinal, sourceEntryId: l.sourceCall.resultEntryId!, edgeId: l.location.edgeId, callerId: l.location.id,
      path: l.location.path, startLine: l.location.startLine, endLine: l.location.endLine, resolution: l.location.resolution,
      novelToText: l.strictNovel, strictNovel: l.strictNovel, assistanceKind: l.location.assistanceKind, strictCallerAssisted: l.location.strictCaller && l.strictNovel,
      coverageLimited: l.coverageLimited, competingTextCallIds: calls.filter(c => end(c) < end(l.graphCall) && exposesPath(c, l.location.path, snapshot)).map(c => c.id),
      evidence: finding.evidence.find(e => sourceMatches(l.sourceCall, e, snapshot))!
    }));
    const localIssues: TraceIssue[] = [];
    const incomplete = !submission || !reads.length || reads.some(r => !r);
    if (incomplete) localIssues.push({ kind: "incomplete_accepted_evidence", severity: "warning", scope: "finding", findingId: finding.id, message: "Accepted canonical submission or exact observed source evidence is missing" });
    const missing = calls.some(c => c.resultEvent === undefined && c.callEvent < (submission?.callEvent ?? 0));
    if (missing) localIssues.push({ kind: "unobserved_result", severity: "warning", scope: "finding", findingId: finding.id, message: "An earlier missing result prevents proof of the observation timeline" });
    const complete = !trace.issues.some(i => i.severity === "fatal") && !incomplete && !missing;
    const novel = chains.filter(c => c.strictNovel);
    const uncertainGraph = calls.some(c => isGraph(c) && finding.evidence.some(e => !changedPaths.has(e.path) && exposesPath(c, e.path, snapshot) && end(c) < (submission?.callEvent ?? -1) && !calls.some(p => !isGraph(p) && end(p) < end(c) && exposesPath(p, e.path, snapshot))));
    const discoveryPath: "graph_assisted" | "text_only" | "ambiguous" = !complete ? "ambiguous" : novel.length ? "graph_assisted" : uncertainGraph ? "ambiguous" : "text_only";
    return { predictionId: finding.id, discoveryPath, assistanceKind: [...new Set(novel.map(c => c.assistanceKind))],
      strictCallerAssisted: complete && novel.some(c => c.strictCallerAssisted), structuralAssisted: complete && novel.some(c => c.assistanceKind !== "entity_search"),
      entitySearchAssisted: complete && novel.some(c => c.assistanceKind === "entity_search"), coverageLimited: novel.some(c => c.coverageLimited),
      submissionCallId: submission?.id ?? null, sourceCallIds: reads.filter((r): r is ToolCall => !!r).map(r => r.id), chains, issues: localIssues,
      reason: !complete ? "Timeline, accepted submission or exact source evidence is incomplete" : novel.length ? "Visible first structural exposure → separately issued source read → exact evidence in accepted finding" : uncertainGraph ? "Graph touched evidence but no definite novel source chain is established" : "Accepted source evidence has no first structural discovery; prior text exposure remains text-only" };
  });
  const submissions = calls.filter(c => c.name === "submit_review");
  return { trace, discoveries, sourceLinks, findings, graphObservations: calls.filter(isGraph).map(c => ({ callId: c.id, coverageLimited: coverageLimited(c), absenceProven: false as const, positiveLocations: locations(c, snapshot).length })), submissionAttempts: submissions.length, submissionValidationFailures: submissions.filter(c => c.isError || c.response?.status === "error").length };
}
