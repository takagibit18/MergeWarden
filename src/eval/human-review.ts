import type { GoldenCase } from "./metrics.ts";

export interface HumanCaseReview {
  caseId: string; baseSha: string; headSha: string;
  verdict: "pending" | "accept" | "needs_revision" | "reject";
  bugExists: string; cleanIsClean: string; expectedBehavior: string;
  severity: string; graphBias: string; rationale: string;
}
export interface HumanReview {
  schemaVersion: 1; corpusSha256: string;
  reviewer: { name: string; kind: "human"; independentOfOriginalAnnotation: boolean };
  humanAttestation: boolean; submittedAt: string | null; cases: HumanCaseReview[];
}
export function humanReviewTemplate(cases: GoldenCase[], corpusSha256: string): HumanReview {
  return { schemaVersion: 1, corpusSha256, reviewer: { name: "", kind: "human", independentOfOriginalAnnotation: false },
    humanAttestation: false, submittedAt: null,
    cases: cases.map(c => ({ caseId: c.id, baseSha: c.baseSha, headSha: c.headSha, verdict: "pending", bugExists: "", cleanIsClean: "", expectedBehavior: "", severity: "", graphBias: "", rationale: "" })) };
}
/** Validates a human's declaration; software cannot independently authenticate who filled a form. Never changes gold. */
export function validateHumanReview(review: HumanReview, cases: GoldenCase[], corpusSha256: string) {
  if (review.schemaVersion !== 1 || review.corpusSha256 !== corpusSha256) throw new Error("Human review corpus mismatch");
  if (!Array.isArray(review.cases) || review.cases.length !== cases.length || new Set(review.cases.map(c => c.caseId)).size !== cases.length) throw new Error("Expected one review row for every frozen case");
  const submitted = review.cases.filter(c => c.verdict !== "pending");
  if (submitted.length && (review.reviewer?.kind !== "human" || !review.reviewer.name.trim() || review.reviewer.independentOfOriginalAnnotation !== true || review.humanAttestation !== true || !review.submittedAt || !Number.isFinite(Date.parse(review.submittedAt)))) throw new Error("Actual human name, independence declaration, attestation and date required");
  const annotations = review.cases.map(row => {
    const gold = cases.find(c => c.id === row.caseId);
    if (!gold || row.baseSha !== gold.baseSha || row.headSha !== gold.headSha) throw new Error("Human review case/SHA mismatch");
    if (row.verdict === "pending") return { caseId: row.caseId, annotationProvenance: { status: "pending_human_review" as const, original: gold.annotationProvenance } };
    if (!["accept", "needs_revision", "reject"].includes(row.verdict) || !row.rationale?.trim()) throw new Error("Human verdict and rationale required");
    for (const value of [row.bugExists, row.cleanIsClean]) if (!["yes", "no", "not_applicable", "uncertain"].includes(value)) throw new Error("Bug and clean assessments required");
    if (!["sufficient", "insufficient", "uncertain"].includes(row.expectedBehavior) || !["critical", "high", "medium", "low", "none", "uncertain"].includes(row.severity) || !["none", "possible", "clear", "uncertain"].includes(row.graphBias)) throw new Error("Behavior, severity and Graph bias assessments required");
    if (row.verdict === "accept" && ((gold.expected === "defect" ? row.bugExists !== "yes" || row.cleanIsClean !== "not_applicable" : row.cleanIsClean !== "yes" || row.bugExists !== "not_applicable") || row.expectedBehavior !== "sufficient" || row.severity !== gold.severity || row.graphBias !== "none")) throw new Error("An accepted annotation must agree on behavior/severity and have no unresolved bias; otherwise mark needs_revision");
    return { caseId: row.caseId, annotationProvenance: { status: row.verdict === "accept" ? "human_reviewed_accepted" as const : "human_reviewed_disputed" as const,
      reviewer: review.reviewer.name, submittedAt: review.submittedAt, corpusSha256, baseSha: row.baseSha, headSha: row.headSha,
      declaration: "Human-authored independent review, self-attested; identity not independently authenticated", assessment: { ...row }, original: gold.annotationProvenance } };
  });
  return { schemaVersion: 1, corpusSha256, reviewed: submitted.length, total: cases.length, complete: submitted.length === cases.length,
    allAccepted: submitted.length === cases.length && submitted.every(c => c.verdict === "accept"), annotations };
}
