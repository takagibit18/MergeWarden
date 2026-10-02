import { EvidenceRegistry, evidenceFields, evidenceRefId, type FindingInput } from "../../application/evidence-registry.ts";
import type { EvidenceRef } from "../../domain/contracts.ts";
import { isObject } from "../../engine/tool-result.ts";
import type { ToolCall } from "./decode.ts";

/** Resolve only explicit IDs exposed by successful earlier read_source content on this branch. */
export function normalizeSubmittedFindings(submit: ToolCall, calls: ToolCall[], snapshot: string): unknown[] {
  const registry = new EvidenceRegistry(snapshot);
  for (const call of calls) {
    const r = call.response;
    if (call.name !== "read_source" || call.argumentsValid === false || call.isError || r?.status !== "ok" || r.snapshotId !== snapshot || (call.resultEvent ?? Infinity) >= submit.callEvent || !isObject(r._mergewarden)) continue;
    const ref = Object.fromEntries(evidenceFields.map(k => [k, r[k]])) as unknown as EvidenceRef;
    if (r._mergewarden.evidenceRefId === evidenceRefId(ref)) registry.register(ref);
  }
  try { return Array.isArray(submit.args.findings) ? registry.normalize(submit.args.findings as FindingInput[]) : []; }
  catch { return []; } // Unknown/unobserved IDs cannot substitute for accepted semantic payload.
}
