import type { FindingCandidate } from "../domain/contracts.ts";
import type { RunManifest } from "../engine/contracts.ts";
export interface GoldenFinding { id: string; path: string; startLine: number; endLine: number; severity: string; behavior: string }
export interface GoldenCase {
  id: string; repositoryIdentity: string; baseSha: string; headSha: string; expected: "defect" | "clean";
  category: string; crossFile: boolean; severity: string; humanRationale: string; behavior: string;
  relevantLocation: { path: string; startLine: number; endLine: number }; annotationProvenance: string;
  expectedFindings: GoldenFinding[]; baseFiles: Record<string, string>; headFiles: Record<string, string>;
}
export interface CaseResult {
  runKey: string; caseId: string; arm: "text-only" | "text+graph"; repeat: number;
  kind: "live-model" | "scripted-offline"; snapshotId: string; status: string; delivered: boolean;
  findings: FindingCandidate[]; manifest?: RunManifest; elapsedMs: number; error?: string;
}
export interface Adjudication {
  runKey: string; status: "pending" | "complete"; reviewer: string;
  predictions: { predictionId: string; goldenId: string | null; rationale: string }[];
}
const ratio = (n: number, d: number): number | null => d ? n / d : null;
/** Explicit semantic adjudication, not location overlap as an automatic correctness oracle. */
export function score(cases: GoldenCase[], runs: CaseResult[], mappings: Adjudication[]) {
  if (new Set(runs.map(r=>r.runKey)).size !== runs.length || new Set(mappings.map(m=>m.runKey)).size !== mappings.length) throw new Error("Duplicate evaluation run/mapping");
  if (mappings.some(m=>!runs.some(r=>r.runKey===m.runKey))) throw new Error("Mapping belongs to another evaluation run");
  const perCase = runs.map(run => {
    const gold = cases.find(c => c.id === run.caseId); if (!gold) throw new Error("Unknown golden case");
    const mapping = mappings.find(m => m.runKey === run.runKey);
    if (run.findings.length && (!mapping || mapping.status !== "complete" || !mapping.reviewer.trim())) throw new Error(`Adjudication pending: ${run.runKey}`);
    const predicted = new Set(run.findings.map(f => f.id)); const used = new Set<string>(); const seen = new Set<string>(); let tp = 0;
    for (const entry of mapping?.predictions ?? []) {
      if (!predicted.has(entry.predictionId) || seen.has(entry.predictionId) || !entry.rationale.trim()) throw new Error("Invalid/duplicate prediction mapping");
      seen.add(entry.predictionId);
      if (entry.goldenId !== null) {
        if (used.has(entry.goldenId) || !gold.expectedFindings.some(f => f.id === entry.goldenId)) throw new Error("Invalid/duplicate golden mapping");
        used.add(entry.goldenId); tp++;
      }
    }
    if (seen.size !== predicted.size) throw new Error(`Unmapped predictions: ${run.runKey}`);
    return { runKey: run.runKey, caseId: run.caseId, arm: run.arm, tp, fp: predicted.size - tp, fn: gold.expectedFindings.length - tp,
      clean: gold.expected === "clean", crossFile: gold.crossFile, complete: run.delivered && run.status === "completed", mapping: mapping ?? { runKey: run.runKey, status: "complete", reviewer: "No predictions to adjudicate", predictions: [] } };
  });
  const byArm = Object.fromEntries((["text-only", "text+graph"] as const).map(arm => {
    const selected = perCase.filter(r => r.arm === arm); const raw = runs.filter(r => r.arm === arm);
    const sum = (key: "tp" | "fp" | "fn") => selected.reduce((n, r) => n + r[key], 0);
    const tp = sum("tp"), fp = sum("fp"), fn = sum("fn");
    const clean = selected.filter(r => r.clean); const defects = selected.filter(r => !r.clean); const cross = selected.filter(r => r.crossFile && !r.clean);
    const token = (key: "input" | "output" | "total") => raw.every(r => r.manifest?.usage) ? raw.reduce((s, r) => s + r.manifest!.usage![key], 0) : null;
    const measured = (read: (m: NonNullable<RunManifest["metrics"]>) => number) => raw.every(r=>r.manifest?.metrics) ? raw.reduce((n,r)=>n+read(r.manifest!.metrics!),0) : null;
    return [arm, { attempted: selected.length, quality: { findingPrecision: ratio(tp, tp + fp), findingRecall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn), cleanPrFalsePositiveRate: ratio(clean.filter(r => r.fp > 0).length, clean.length), prLevelRecall: ratio(defects.filter(r => r.tp > 0).length, defects.length), crossFileRecall: ratio(cross.reduce((n,r)=>n+r.tp,0), cross.reduce((n,r)=>n+r.tp+r.fn,0)), completeDeliveryRate: ratio(selected.filter(r=>r.complete).length,selected.length), tp, fp, fn },
      cost: { inputTokens: token("input"), outputTokens: token("output"), totalTokens: token("total"), toolCalls: measured(m=>m.toolCalls), graphToolCalls: measured(m=>m.graphToolCalls), totalReviewLatencyMs: raw.reduce((n,r)=>n+r.elapsedMs,0), graphBuildLatencyMs: measured(m=>m.graph.buildMs) },
      graphDiagnostics: raw.map(r=>({runKey:r.runKey, ...(r.manifest?.metrics?.graph ?? { unavailable:true })})) }];
  }));
  return { interpretation: "Quality requires semantic mappings. Failed/partial attempts remain in recall and delivery denominators. Null means no denominator or unavailable usage. Scripted runs do not measure model quality.", perCase, byArm };
}
