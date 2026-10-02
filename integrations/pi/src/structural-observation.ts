/** Private, deterministic attribution. Does not activate tools or change route budgets. */
export interface Discovery {
  routeId: string; path: string; entityId: string; startLine: number; endLine: number;
  discoveryMode: "entity_search" | "traversal"; graphCallId: string; ordinal: number;
  sourceCallId?: string; sourceOrdinal?: number;
}
export interface StructuralObservation {
  seenPaths: string[]; graphDiscoveredPaths: Discovery[]; synthesized: string[];
  episodes: Record<string, { R0: boolean; R1: boolean; R2: boolean; R3: boolean; R4: boolean }>;
}
export const freshObservation = (paths: string[]): StructuralObservation => ({ seenPaths: [...paths], graphDiscoveredPaths: [], synthesized: [], episodes: {} });
const object = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
export function observeResult(state: StructuralObservation, event: { toolName: string; toolCallId?: string; details?: unknown; isError?: boolean }, snapshotId: string, routeId: string | undefined, ordinal: number): Discovery[] {
  const r = object(event.details), verified: Discovery[] = [];
  if (event.isError || r.snapshotId !== snapshotId || !["ok", "partial", "parse_incomplete"].includes(String(r.status))) return verified;
  const items = (Array.isArray(r.items) ? r.items : []).map(object);
  if (event.toolName === "read_source" && r.status === "ok" && r.revision === "head") {
    for (const d of state.graphDiscoveredPaths) {
      if (d.sourceCallId === undefined && d.path === r.path && Number(r.startLine) <= d.startLine && Number(r.endLine) >= d.endLine) {
        d.sourceCallId = event.toolCallId ?? `ordinal:${ordinal}`; d.sourceOrdinal = ordinal;
        state.episodes[d.routeId]!.R4 = true; verified.push(d);
      }
    }
  }
  if (["search_entity", "traverse_graph"].includes(event.toolName) && r.revision === "head" && routeId) {
    for (const e of items) {
      if (typeof e.path !== "string" || state.seenPaths.includes(e.path) || typeof e.entityId !== "string" || !Number.isInteger(e.startLine) || !Number.isInteger(e.endLine) || Number(e.startLine) < 1 || Number(e.endLine) < Number(e.startLine)) continue;
      if (event.toolName === "traverse_graph" && !(Number(e.depth) > 0)) continue;
      state.graphDiscoveredPaths.push({ routeId, path: e.path, entityId: e.entityId, startLine: Number(e.startLine), endLine: Number(e.endLine), discoveryMode: event.toolName === "traverse_graph" ? "traversal" : "entity_search", graphCallId: event.toolCallId ?? `ordinal:${ordinal}`, ordinal });
      state.episodes[routeId]!.R3 = true;
    }
  }
  // Exposure counts even on base revision and includes Graph candidate hints.
  const paths: unknown[] = [];
  if (["read_source", "read_diff"].includes(event.toolName)) paths.push(r.path);
  if (["search_text", "search_entity", "traverse_graph"].includes(event.toolName)) {
    paths.push(...items.map(e => e.path));
    for (const hint of Array.isArray(r.hints) ? r.hints : [r.hints]) {
      const hints = object(hint);
      if (Array.isArray(hints.candidates)) paths.push(...hints.candidates.map(e => object(e).path));
    }
  }
  state.seenPaths = [...new Set([...state.seenPaths, ...paths.filter((p): p is string => typeof p === "string")])];
  return verified;
}
