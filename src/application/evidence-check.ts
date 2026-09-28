import { createHash } from "node:crypto";
import type { EvidenceRef, FindingCandidate } from "../domain/contracts.ts";
import type { SourceReader } from "../ports/source.ts";
/** Checks source integrity only; does not decide semantic correctness. */
export interface EvidenceFailure { candidateId: string; evidenceIndex: number; reference: EvidenceRef; code: "SOURCE_HASH_MISMATCH" | "SOURCE_UNAVAILABLE" }
export async function checkEvidence(candidate: FindingCandidate, source: SourceReader): Promise<{ ok: boolean; failures: string[]; issues: EvidenceFailure[] }> {
  const failures: string[] = [];
  const issues: EvidenceFailure[] = [];
  for (const [evidenceIndex, ref] of candidate.evidence.entries()) {
    const fail = (code: EvidenceFailure["code"], message: string) => {
      failures.push(`${candidate.id} evidence[${evidenceIndex}] ${ref.revision} ${ref.path}:${ref.startLine}-${ref.endLine}: ${message}`);
      issues.push({ candidateId: candidate.id, evidenceIndex, reference: structuredClone(ref), code });
    };
    try {
      const result = await source.read(ref);
      const measured = createHash("sha256").update(result.text, "utf8").digest("hex");
      if (measured !== ref.contentSha256 || result.actualSha256 !== measured) fail("SOURCE_HASH_MISMATCH", "source hash mismatch");
    } catch { fail("SOURCE_UNAVAILABLE", "source unavailable"); }
  }
  return { ok: failures.length === 0, failures, issues };
}
