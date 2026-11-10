import { access } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../infrastructure/git.ts";
import { atomicWrite, safePath, sha256 } from "../infrastructure/files.ts";
import { SnapshotStore } from "./store.ts";

/**
 * Restore the text blobs of a commit snapshot from Git objects. Persisted state keeps only the manifest; every restored
 * blob must match the hash the manifest froze, so a rewritten history or a different commit cannot leak into evidence.
 */
export async function hydrateSnapshot(stateDir: string, snapshotId: string, repositoryPath: string, signal?: AbortSignal): Promise<{ restored: number; present: number }> {
  const store = await SnapshotStore.load(stateDir, snapshotId);
  const { identity, input } = store.manifest;
  if (input.kind !== "commits" || !identity.baseCommit || !identity.headCommit) throw new Error("Only commit snapshots can be restored from Git");
  let restored = 0, present = 0;
  for (const [revision, commit] of [["base", identity.baseCommit], ["head", identity.headCommit]] as const) {
    const wanted = new Map<string, string>();
    for (const [path, file] of Object.entries(store.manifest[revision])) {
      if (file.status !== "text") continue;
      try { await access(join(stateDir, "blobs", file.hash)); present++; } catch { wanted.set(safePath(path), file.hash); }
    }
    if (!wanted.size) continue;
    const listing = (await git(repositoryPath, ["ls-tree", "-rz", "--full-tree", commit], signal)).toString("utf8").split("\0").filter(Boolean);
    const oids = new Map<string, string>();
    for (const row of listing) { const tab = row.indexOf("\t"); const path = row.slice(tab + 1); if (wanted.has(path)) oids.set(path, row.slice(0, tab).split(" ")[2]!); }
    const paths = [...wanted.keys()];
    if (paths.some(path => !oids.has(path))) throw new Error("Snapshot restore: commit tree differs from the frozen manifest");
    const output = await git(repositoryPath, ["cat-file", "--batch"], signal, paths.map(path => oids.get(path)).join("\n") + "\n");
    let cursor = 0;
    for (const path of paths) {
      const newline = output.indexOf(10, cursor); const size = Number(output.subarray(cursor, newline).toString().split(" ")[2]);
      if (newline < 0 || !Number.isSafeInteger(size)) throw new Error("Snapshot restore: invalid Git object batch");
      const bytes = output.subarray(newline + 1, newline + 1 + size); cursor = newline + size + 2;
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (sha256(bytes) !== wanted.get(path)) throw new Error("Snapshot restore: blob hash differs from the frozen manifest");
      await atomicWrite(join(stateDir, "blobs", wanted.get(path)!), text); restored++;
    }
  }
  return { restored, present };
}
