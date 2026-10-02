import type { EvidenceRef } from "../domain/contracts.ts";
/** Must read immutable base/head sources, not a live worktree changing during review. */
export interface SourceReader {
  read(ref: EvidenceRef): Promise<{ text: string; actualSha256: string }>;
}
export interface SnapshotProvider {
  freeze(input: { repositoryPath: string; base: string; head: string }): Promise<import("../domain/contracts.ts").SnapshotIdentity>;
}
