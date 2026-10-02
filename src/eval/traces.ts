import type { ToolCall } from "./provenance/decode.ts";
import { observe, usable as ok, sourceCovers, exposesPath } from "./provenance/observations.ts";
export { decodePiTrace, type ToolCall, type DecodedTrace, type TraceIssue, type TraceUsage } from "./provenance/decode.ts";
import type { FindingCandidate } from "../domain/contracts.ts";
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => typeof v === "object" && v !== null && !Array.isArray(v);
const records = (v: unknown): ObjectValue[] => Array.isArray(v) ? v.filter(object) : [];
const items = (call: ToolCall): ObjectValue[] => records(call.response?.items);
const graph = (call: ToolCall) => call.name === "graph_lookup" || call.name === "graph_neighbors";
const position = (call: ToolCall) => call.resultEvent ?? Infinity;
export function analyzeTrace(input: { runKey: string; snapshotId: string; findings: FindingCandidate[]; jsonl: string; changedPaths?: readonly string[] }) {
  const observation = observe(input), trace = observation.trace, calls = trace.calls, snapshotId = input.snapshotId;
  const graphs = calls.filter(graph); const lookups = graphs.filter(c => c.name === "graph_lookup"); const neighbors = graphs.filter(c => c.name === "graph_neighbors");
  const hits = lookups.filter(c => ok(c, snapshotId) && items(c).some(s => s.snapshotId === snapshotId && typeof s.id === "string"));
  const lookupConversions = new Set<string>();
  const lookupLinks: { lookupCallId: string; neighborCallId: string; symbolId: string }[] = [];
  for (const neighbor of neighbors) {
    const lookup = hits.findLast(l => position(l) < neighbor.callEvent && items(l).some(s => s.id === neighbor.args.symbolId));
    if (lookup) { lookupConversions.add(lookup.id); lookupLinks.push({ lookupCallId: lookup.id, neighborCallId: neighbor.id, symbolId: String(neighbor.args.symbolId) }); }
  }
  const returnedNeighbors = neighbors.filter(c => ok(c, snapshotId) && items(c).length > 0);
  const neighborLinks: { neighborCallId: string; sourceCallId: string; path: string; newToText: boolean }[] = [];
  for (const neighbor of returnedNeighbors) for (const row of items(neighbor)) {
    if (row.snapshotId !== snapshotId || typeof row.sourcePath !== "string" || !Number.isInteger(row.sourceLine) || !Number.isInteger(row.sourceEndLine)) continue;
    const location = { edgeId: String(row.id), callerId: String(row.fromId), path: row.sourcePath, startLine: Number(row.sourceLine), endLine: Number(row.sourceEndLine), resolution: String(row.resolution) };
    const source = calls.find(c => c.callEvent > position(neighbor) && sourceCovers(c, location, snapshotId));
    if (source) neighborLinks.push({ neighborCallId: neighbor.id, sourceCallId: source.id, path: location.path, newToText: !calls.some(c => position(c) < position(neighbor) && exposesPath(c, location.path, snapshotId)) });
  }
  const findings = observation.findings;
  const graphChars = graphs.reduce((n, c) => n + [...c.resultText].length, 0);
  const count = (name: string) => calls.filter(c => c.name === name).length;
  const numerator = new Set(neighborLinks.map(l => l.neighborCallId)).size;
  return { schemaVersion: 1, attributionVersion: "trace-attribution-3", runKey: input.runKey, snapshotId, traceSha256: trace.sha256, traceIssues: trace.issues, ignoredBranchEntries: trace.ignoredBranchEntries, usage: trace.usage,
    metrics: { submissionAttempts: observation.submissionAttempts, submissionValidationFailures: observation.submissionValidationFailures, toolCalls: calls.length, graphToolCalls: graphs.length, graphResults: graphs.filter(g => g.resultEvent !== undefined).length, firstGraphToolOrdinal: graphs[0]?.ordinal ?? null,
      lookupCalls: lookups.length, lookupSuccessfulCalls: lookups.filter(c => ok(c, snapshotId)).length, lookupHits: hits.length,
      lookupSuccessRate: lookups.length ? lookups.filter(c => ok(c, snapshotId)).length / lookups.length : null, lookupHitRate: lookups.length ? hits.length / lookups.length : null,
      lookupToNeighbors: { converted: lookupConversions.size, eligible: hits.length, rate: hits.length ? lookupConversions.size / hits.length : null },
      neighborsToReadSource: { converted: numerator, eligible: returnedNeighbors.length, rate: returnedNeighbors.length ? numerator / returnedNeighbors.length : null },
      newCallerReadConversions: new Set(neighborLinks.filter(l => l.newToText).map(l => l.neighborCallId)).size,
      searchTextCalls: count("search_text"), readSourceCalls: count("read_source"), rejectedSubmissions: calls.filter(c => c.name === "submit_review" && (c.isError || c.response?.status === "error")).length,
      graphResponseUtf8Bytes: graphs.reduce((n, c) => n + Buffer.byteLength(c.resultText, "utf8"), 0), graphResponseCharacters: graphChars,
      graphResponseTokens: null, graphResponseTokenEstimate: Math.ceil(graphChars / 4), tokenEstimateMethod: "Unicode code points / 4, rounded up; NOT GLM tokenization or billed input tokens; tool response text counted once" },
    lookupLinks, neighborLinks, findings,
    calls: calls.map(c => ({ toolCallId: c.id, name: c.name, ordinal: c.ordinal, callEntryId: c.callEntryId, resultEntryId: c.resultEntryId ?? null, status: c.response?.status ?? (c.response?.accepted ? "accepted" : null), isError: c.isError, resultMissing: c.resultEvent === undefined, returnedItems: items(c).length })) };
}
export type TraceAnalysis = ReturnType<typeof analyzeTrace>;
