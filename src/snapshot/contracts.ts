import type { SnapshotIdentity } from "../domain/contracts.ts";
export type ReviewInput =
  | { kind: "commits"; base: string; head: string }
  | { kind: "staged" }
  | { kind: "worktree"; includeUntracked?: string[] };
export interface FrozenFile { hash: string; bytes: number; status: "text" | "binary" | "symlink" | "submodule" | "too_large"; mode: string }
export interface SnapshotManifest {
  schemaVersion: 2; identity: SnapshotIdentity; repositoryPath: string; input: ReviewInput;
  base: Record<string, FrozenFile>; head: Record<string, FrozenFile>; changedPaths: string[]; createdAt: string;
}
export interface SourcePage {
  snapshotId: string; revision: "base" | "head"; path: string; status: "ok" | "unavailable";
  text: string; startLine: number; endLine: number; totalLines: number; contentSha256: string;
  /** True only when requested source was omitted, not when the file continues. */
  truncated: boolean; hasMoreLines?: boolean; warnings: string[];
}
