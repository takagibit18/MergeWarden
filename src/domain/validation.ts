import type { FindingCandidate, SnapshotIdentity } from "./contracts.ts";
export function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function requireText(value: unknown, label: string): asserts value is string {
  requireCondition(typeof value === "string" && value.trim().length > 0, `${label} must be non-empty`);
}
export function assertSnapshot(value: unknown): asserts value is SnapshotIdentity {
  requireCondition(isRecord(value), "snapshot must be an object");
  for (const key of ["id", "repositoryId", "inputFingerprint", "configurationFingerprint"]) {
    requireText(value[key], `snapshot.${key}`);
  }
  if (value.baseCommit !== undefined) requireCondition(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(String(value.baseCommit)), "base must be a resolved commit id");
  if (value.headCommit !== undefined) requireCondition(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(String(value.headCommit)), "head must be a resolved commit id");
  requireCondition((value.baseCommit && value.headCommit) || (isRecord(value.baseVersion) && isRecord(value.headVersion)), "snapshot versions are required");
  for (const [version, commit] of [[value.baseVersion, value.baseCommit], [value.headVersion, value.headCommit]]) {
    if (version === undefined) continue;
    requireCondition(isRecord(version) && ["commit", "content", "empty"].includes(String(version.kind)), "invalid source version");
    requireCondition(typeof version.id === "string" && (version.kind === "commit" ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(version.id) : /^[a-f0-9]{64}$/.test(version.id)), "invalid source version id");
    requireCondition(version.kind === "commit" ? commit === version.id : commit === undefined, "source version does not match commit identity");
  }
}
export function assertCandidate(value: unknown, snapshotId: string): asserts value is FindingCandidate {
  requireCondition(isRecord(value), "candidate must be an object");
  for (const key of ["id", "title", "claim", "trigger", "impact"]) { requireText(value[key], key); requireCondition(value[key].length <= 4000, `${key} exceeds limit`); }
  requireCondition(["critical", "high", "medium", "low"].includes(String(value.severity)), "invalid severity");
  requireCondition(Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 20, "candidate needs evidence references");
  for (const evidence of value.evidence) {
    requireCondition(isRecord(evidence), "invalid evidence");
    requireCondition(evidence.snapshotId === snapshotId, "evidence snapshot mismatch");
    requireCondition(evidence.revision === "base" || evidence.revision === "head", "evidence revision required");
    requireText(evidence.path, "evidence.path");
    const path = evidence.path;
    requireCondition(!path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
      !path.split("/").some((part) => part === ".." || part === "." || part === ""), "unsafe relative evidence path");
    requireCondition(Number.isInteger(evidence.startLine) && Number(evidence.startLine) >= 1, "invalid start line");
    requireCondition(Number.isInteger(evidence.endLine) && Number(evidence.endLine) >= Number(evidence.startLine), "invalid end line");
    requireCondition(typeof evidence.contentSha256 === "string" && /^[a-f0-9]{64}$/i.test(evidence.contentSha256), "invalid content hash");
  }
}
