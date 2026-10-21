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
  if (value.acceptedTradeoff !== undefined) {
    const fold = value.acceptedTradeoff;
    requireCondition(isRecord(fold) && Object.keys(fold).sort().join() === "note,revision,skillId" && typeof fold.skillId === "string" && /^sk_[a-z0-9_-]{1,64}$/.test(fold.skillId) &&
      Number.isSafeInteger(fold.revision) && Number(fold.revision) >= 1 && typeof fold.note === "string" && fold.note.trim().length > 0 && fold.note.length <= 1000, "invalid accepted trade-off");
    requireCondition(value.severity === "low" || value.severity === "medium", "critical and high findings are never folded");
    requireCondition(value.acceptedTradeoffRejected === undefined, "a finding is folded or rejected, not both");
  }
  if (value.acceptedTradeoffRejected !== undefined) { requireText(value.acceptedTradeoffRejected, "acceptedTradeoffRejected"); requireCondition(value.acceptedTradeoffRejected.length <= 300, "acceptedTradeoffRejected exceeds limit"); }
}
export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Exactly the output of Date#toISOString; used for timestamps this process writes. */
export const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** UTC timestamps written by native artifacts, which may carry up to nanosecond precision. */
export const isNativeTimestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
