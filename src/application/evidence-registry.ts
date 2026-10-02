import { createHash } from "node:crypto";
import type { EvidenceRef, FindingCandidate } from "../domain/contracts.ts";
import { isRecord, requireCondition } from "../domain/validation.ts";

export type EvidenceInput = EvidenceRef | { evidenceRefId: string };
export type FindingInput = Omit<FindingCandidate, "evidence"> & { evidence: readonly EvidenceInput[] };
export const evidenceFields = ["snapshotId", "revision", "path", "startLine", "endLine", "contentSha256"] as const;
export const evidenceIdentity = (e: EvidenceRef): string => JSON.stringify(evidenceFields.map(k => e[k]));
export const evidenceRefId = (e: EvidenceRef): string => "ev_" + createHash("sha256").update(evidenceIdentity(e)).digest("hex");
export const fullEvidence = (e: EvidenceRef): EvidenceRef => Object.fromEntries(evidenceFields.map(k => [k, e[k]])) as unknown as EvidenceRef;

/** Mechanical provenance for one Engine run. Registration is called only after successful source reads. */
export class EvidenceRegistry {
  private readonly snapshotId: string;
  private readonly entries = new Map<string, EvidenceRef>();
  constructor(snapshotId: string) { this.snapshotId = snapshotId; }
  register(evidence: EvidenceRef): string {
    requireCondition(evidence.snapshotId === this.snapshotId, "Evidence registry snapshot mismatch");
    const ref = fullEvidence(evidence), id = evidenceRefId(ref);
    this.entries.set(id, structuredClone(ref)); return id;
  }
  resolve(id: string): EvidenceRef {
    const ref = this.entries.get(id);
    requireCondition(ref && ref.snapshotId === this.snapshotId, "Unknown evidence reference in this run: " + id);
    return structuredClone(ref);
  }
  normalize(findings: readonly FindingInput[]): FindingCandidate[] {
    return findings.map(candidate => {
      requireCondition(isRecord(candidate) && Array.isArray(candidate.evidence) && candidate.evidence.length > 0 && candidate.evidence.length <= 20, "Candidate needs 1–20 explicit evidence references");
      const seen = new Set<string>(), evidence: EvidenceRef[] = [];
      for (const input of candidate.evidence) {
        requireCondition(isRecord(input), "Invalid evidence input");
        let ref: EvidenceRef;
        if (Object.hasOwn(input, "evidenceRefId")) {
          requireCondition(Object.keys(input).length === 1 && typeof input.evidenceRefId === "string", "Evidence ID reference must contain only evidenceRefId");
          ref = this.resolve(input.evidenceRefId);
        } else ref = structuredClone(input) as unknown as EvidenceRef;
        const key = evidenceIdentity(ref);
        if (!seen.has(key)) { seen.add(key); evidence.push(ref); }
      }
      return { ...candidate, evidence };
    });
  }
}
