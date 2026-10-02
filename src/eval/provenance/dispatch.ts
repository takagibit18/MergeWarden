import { createHash } from "node:crypto";
import { EvidenceRegistry, evidenceIdentity, evidenceRefId } from "../../application/evidence-registry.ts";
import type { FindingInput } from "../../application/evidence-registry.ts";
import type { FindingCandidate } from "../../domain/contracts.ts";
import { DISPATCH_EVENT, DISPATCH_MESSAGE } from "../../engine/dispatch-service.ts";
import type { ContextPackage, DispatchSource } from "../../engine/dispatch-contracts.ts";
import { decodePiTrace } from "./decode.ts";
import { isObject } from "../../engine/tool-result.ts";
import { analyzeRetrieval } from "../../experiments/locagent/traces.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (f: FindingCandidate) => JSON.stringify([f.id, f.title, f.claim, f.trigger, f.impact, f.severity, f.evidence.map(evidenceIdentity).sort()]);

/** Separate version: never relax or modify historical v3 Graph->model source attribution. */
export function analyzeDispatch(input: { runId: string; runKey: string; snapshotId: string; findings: FindingCandidate[]; jsonl: string; changedPaths?: readonly string[] }) {
  const trace = decodePiTrace(input.jsonl), old = analyzeRetrieval(input);
  const result = { version: "host-dispatch-attribution-1", traceIssues: trace.issues, model_selected_graph_assistance: old.metrics.graphAssistedFindings,
    host_dispatched_structural_assistance: 0, packagesObserved: 0, packagesDelivered: 0,
    findings: [] as { findingId: string; requestIds: string[]; evidenceRefIds: string[] }[] };
  if (trace.issues.some(x => x.severity === "fatal")) return result;
  const rows = input.jsonl.trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(isObject);
  const byId = new Map(rows.filter(r => typeof r.id === "string").map(r => [r.id, r]));
  const branch: Record<string, unknown>[] = []; let node = rows.findLast(r => typeof r.id === "string");
  while (node) { branch.unshift(node); node = byId.get(node.parentId); }
  const packages: { pack: ContextPackage; event: number; delivered: number; sources: DispatchSource[] }[] = [];
  for (const [event, row] of branch.entries()) {
    if (row.type !== "custom_message" || row.customType !== DISPATCH_MESSAGE || typeof row.content !== "string") continue;
    try {
      const pack = JSON.parse(row.content) as ContextPackage;
      if (pack.version !== "structural-dispatch-1" || pack.origin !== "host_dispatch" || pack.runId !== input.runId || pack.snapshotId !== input.snapshotId || !pack.generationId || !pack.anchor) continue;
      result.packagesObserved++;
      const delivered = branch.findIndex((r, i) => i > event && r.type === "custom" && r.customType === DISPATCH_EVENT && isObject(r.data)
        && r.data.type === "context_delivered" && r.data.runId === input.runId && r.data.snapshotId === input.snapshotId
        && r.data.requestId === pack.requestId && r.data.packageSha256 === hash(String(row.content)));
      if (delivered < 0) continue;
      const reached = new Set([pack.anchor.entityId]);
      // Paths are navigation proof only. The package's frozen template defines query direction.
      for (let n = 0; n < 3; n++) for (const e of pack.relations) {
        if (e.snapshotId !== input.snapshotId || !["resolved_scoped", "resolved_import_alias"].includes(e.resolution)) continue;
        if (reached.has(e.fromId)) reached.add(e.toId); if (reached.has(e.toId)) reached.add(e.fromId);
      }
      const sources = pack.sources.filter(s => s.snapshotId === input.snapshotId && s.revision === "head" && evidenceRefId(s) === s.evidenceRefId
        && hash(s.text) === s.contentSha256 && s.entity?.snapshotId === input.snapshotId && s.entity.path === s.path && reached.has(s.entity.entityId));
      packages.push({ pack, event, delivered, sources }); result.packagesDelivered++;
    } catch { /* Malformed custom data is not evidence. */ }
  }
  for (const finding of input.findings) {
    const used = new Map<string, string>();
    for (const submit of trace.calls.filter(c => c.name === "submit_review" && !c.isError && c.response?.accepted === true)) {
      const registry = new EvidenceRegistry(input.snapshotId);
      for (const call of trace.calls) if (call.name === "read_source" && !call.isError && call.response?.status === "ok" && call.response.snapshotId === input.snapshotId && (call.resultEvent ?? Infinity) < submit.callEvent)
        registry.register(call.response as unknown as DispatchSource);
      const eligible = packages.filter(p => p.delivered < submit.callEvent);
      for (const p of eligible) for (const s of p.sources) registry.register(s);
      let normalized: FindingCandidate[];
      try { normalized = registry.normalize(submit.args.findings as FindingInput[]); } catch { continue; }
      if (!normalized.some(f => canonical(f) === canonical(finding))) continue;
      for (const p of eligible) for (const source of p.sources) if (finding.evidence.some(e => evidenceIdentity(e) === evidenceIdentity(source))) used.set(source.evidenceRefId, p.pack.requestId);
    }
    result.findings.push({ findingId: finding.id, requestIds: [...new Set(used.values())], evidenceRefIds: [...used.keys()] });
    if (used.size) result.host_dispatched_structural_assistance++;
  }
  return result;
}
