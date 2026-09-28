import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { frozenDiff } from "./diff.ts";
import { git } from "../infrastructure/git.ts";
import { atomicWrite, inside, isolatedState, safePath, sha256, writeJson } from "../infrastructure/files.ts";
import { assertSnapshot } from "../domain/validation.ts";
import type { EvidenceRef, SnapshotIdentity } from "../domain/contracts.ts";
import type { SourceReader } from "../ports/source.ts";
import type { FrozenFile, ReviewInput, SnapshotManifest, SourcePage } from "./contracts.ts";
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_TOTAL = 100 * 1024 * 1024;
export class SnapshotStore implements SourceReader {
  readonly stateDir: string;
  readonly manifest: SnapshotManifest;
  constructor(stateDir: string, manifest: SnapshotManifest) { this.stateDir = stateDir; this.manifest = structuredClone(manifest); }
  static async freeze(options: { repositoryPath: string; stateDir: string; input: ReviewInput; configuration: unknown; signal?: AbortSignal }, hooks: { beforeVerify?: () => Promise<void> } = {}): Promise<SnapshotStore> {
    const repository = await realpath(options.repositoryPath);
    const runGit = (args: string[], input?: string) => { options.signal?.throwIfAborted(); return git(repository, args, options.signal, input); };
    const root = (await runGit(["rev-parse", "--show-toplevel"])).toString("utf8").trim();
    if (await realpath(root) !== repository) throw new Error("Choose the repository root");
    const state = await isolatedState(options.stateDir, repository);
    const resolveCommit = async (ref: string) => {
      if (!ref || ref.startsWith("-")) throw new Error("Invalid Git revision");
      return (await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim();
    };
    let baseCommit: string | undefined;
    let headCommit: string | undefined;
    if (options.input.kind === "commits") { baseCommit = await resolveCommit(options.input.base); headCommit = await resolveCommit(options.input.head); }
    else { try { baseCommit = await resolveCommit("HEAD"); } catch { const unborn = (await runGit(["symbolic-ref", "-q", "HEAD"])).toString().trim(); if (!unborn) throw new Error("Cannot resolve HEAD"); } }
    type Entry = { path: string; mode: string; oid: string };
    const tree = async (commit?: string): Promise<Entry[]> => !commit ? [] : (await runGit(["ls-tree", "-rz", "--full-tree", commit])).toString("utf8").split("\0").filter(Boolean).map(row => {
      const tab = row.indexOf("\t"); const [mode, , oid] = row.slice(0, tab).split(" ");
      return { path: safePath(row.slice(tab + 1)), mode: mode!, oid: oid! };
    });
    const index = async (): Promise<Entry[]> => (await runGit(["ls-files", "--stage", "-z"])).toString("utf8").split("\0").filter(Boolean).map(row => {
      const tab = row.indexOf("\t"); const [mode, oid, stage] = row.slice(0, tab).split(" ");
      if (stage !== "0") throw new Error("Unmerged index: resolve conflicts before review");
      return { path: safePath(row.slice(tab + 1)), mode: mode!, oid: oid! };
    });
    let total = 0;
    const save = async (bytes: Buffer, mode: string): Promise<FrozenFile> => {
      total += bytes.length; if (total > MAX_TOTAL) throw new Error("Snapshot exceeds 100 MiB capture limit");
      const status: FrozenFile["status"] = mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : bytes.length > MAX_FILE ? "too_large" : bytes.includes(0) ? "binary" : "text";
      let text = "";
      if (status === "text") { try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { hash: sha256(bytes), bytes: bytes.length, status: "binary", mode }; } }
      const hash = sha256(bytes);
      if (status === "text") await atomicWrite(join(state, "blobs", hash), text);
      return { hash, bytes: bytes.length, status, mode };
    };
    const objects = new Map<string, FrozenFile>();
    const captureTree = async (entries: Entry[]): Promise<Record<string, FrozenFile>> => {
      if (entries.length > MAX_FILES) throw new Error("Snapshot exceeds file limit");
      const pending = [...new Map(entries.filter(e => !objects.has(e.oid)).map(e => [e.oid, e])).values()];
      const blobs = pending.filter(e => e.mode !== "160000");
      const sizes = blobs.length ? (await runGit(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], blobs.map(e => e.oid).join("\n") + "\n")).toString().trim().split("\n") : [];
      const readable: Entry[] = [];
      for (let i = 0; i < blobs.length; i++) {
        const e = blobs[i]!; const [oid, type, rawSize] = sizes[i]!.split(" "); const size = Number(rawSize);
        if (oid !== e.oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git object");
        if (size > MAX_FILE) objects.set(e.oid, { hash: sha256(e.oid), bytes: size, status: "too_large", mode: e.mode });
        else readable.push(e);
      }
      const batchBytes = sizes.reduce((sum, row) => { const n = Number(row.split(" ")[2]); return sum + (n <= MAX_FILE ? n : 0); }, 0);
      if (total + batchBytes > MAX_TOTAL) throw new Error("Snapshot exceeds 100 MiB capture limit");
      const output = readable.length ? await runGit(["cat-file", "--batch"], readable.map(e => e.oid).join("\n") + "\n") : Buffer.alloc(0);
      let cursor = 0;
      for (const e of readable) {
        const newline = output.indexOf(10, cursor); const [oid, type, rawSize] = output.subarray(cursor, newline).toString().split(" "); const size = Number(rawSize);
        if (newline < 0 || oid !== e.oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || newline + 1 + size >= output.length) throw new Error("Invalid Git object batch");
        objects.set(e.oid, await save(output.subarray(newline + 1, newline + 1 + size), "100644")); cursor = newline + size + 2;
      }
      const files: Record<string, FrozenFile> = Object.create(null);
      for (const e of entries) {
        options.signal?.throwIfAborted();
        const cached = e.mode === "160000" ? await save(Buffer.from(e.oid), e.mode) : objects.get(e.oid)!;
        // The same blob may be a regular file and a symbolic link in different trees.
        files[e.path] = { ...cached, mode: e.mode, status: e.mode === "120000" ? "symlink" : cached.status === "symlink" ? "text" : cached.status };
      }
      return files;
    };
    const captureLive = async (entries: Entry[]): Promise<Record<string, FrozenFile>> => {
      const files: Record<string, FrozenFile> = Object.create(null);
      if (entries.length > MAX_FILES) throw new Error("Snapshot exceeds file limit");
      for (const e of entries) {
        options.signal?.throwIfAborted();
        if (e.mode === "160000") { files[e.path] = await save(Buffer.from(e.oid), e.mode); continue; }
        const file = resolve(repository, safePath(e.path));
        try {
          let parent = repository;
          for (const segment of e.path.split("/")) { parent = join(parent, segment); if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Symlink in worktree path: ${e.path}`); }
          if (!inside(repository, await realpath(file))) throw new Error("Source path escaped repository");
          const handle = await open(file, "r");
          try {
            const before = await handle.stat(); if (!before.isFile() || before.size > MAX_FILE) throw new Error(`Unsupported/oversized worktree file: ${e.path}`);
            const bytes = await handle.readFile(); const after = await handle.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || !inside(repository, await realpath(file))) throw new Error("Worktree changed while reading; retry");
            files[e.path] = await save(bytes, process.platform === "win32" || e.mode === "120000" ? e.mode : before.mode & 0o111 ? "100755" : "100644");
          } finally { await handle.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return files;
    };
    const base = await captureTree(await tree(baseCommit));
    let head: Record<string, FrozenFile>;
    if (options.input.kind === "commits") head = await captureTree(await tree(headCommit));
    else {
      const initialIndex = await index();
      let entries = initialIndex;
      if (options.input.kind === "worktree") {
        const allowed = new Set((await runGit(["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean));
        const extra = [...new Set(options.input.includeUntracked ?? [])].map(path => { safePath(path); if (!allowed.has(path)) throw new Error(`Not an eligible untracked file: ${path}`); return { path, mode: "100644", oid: "" }; });
        entries = [...initialIndex, ...extra];
      }
      head = options.input.kind === "staged" ? await captureTree(entries) : await captureLive(entries);
      await hooks.beforeVerify?.();
      const second = options.input.kind === "staged" ? head : await captureLive(entries);
      if (JSON.stringify(head) !== JSON.stringify(second) || JSON.stringify(initialIndex) !== JSON.stringify(await index())) throw new Error("Index/worktree changed during capture; retry");
      let current: string | undefined; try { current = await resolveCommit("HEAD"); } catch { /* unborn checked above */ }
      if (current !== baseCommit) throw new Error("HEAD changed during capture; retry");
    }
    const baseHash = sha256(JSON.stringify(base)); const headHash = sha256(JSON.stringify(head));
    const repositoryId = sha256(repository); const configurationFingerprint = sha256(JSON.stringify(options.configuration));
    const inputFingerprint = sha256(JSON.stringify({ baseHash, headHash, kind: options.input.kind, baseCommit, headCommit }));
    const identity: SnapshotIdentity = { id: sha256(repositoryId + inputFingerprint + configurationFingerprint), repositoryId, inputFingerprint, configurationFingerprint,
      ...(baseCommit ? { baseCommit } : {}), ...(headCommit ? { headCommit } : {}),
      baseVersion: { kind: baseCommit ? "commit" : "empty", id: baseCommit ?? baseHash },
      headVersion: { kind: options.input.kind === "commits" ? "commit" : "content", id: headCommit ?? headHash } };
    const changedPaths = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter(path => base[path]?.hash !== head[path]?.hash || base[path]?.mode !== head[path]?.mode).sort();
    const manifest: SnapshotManifest = { schemaVersion: 2, identity, repositoryPath: repository, input: options.input, base, head, changedPaths, createdAt: new Date().toISOString() };
    const manifestPath = join(state, "snapshots", identity.id + ".json");
    try { return await SnapshotStore.load(state, identity.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeJson(manifestPath, manifest);
    return new SnapshotStore(state, manifest);
  }
  static async load(stateDir: string, id: string): Promise<SnapshotStore> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid snapshot id");
    const manifest = JSON.parse(await readFile(join(stateDir, "snapshots", id + ".json"), "utf8")) as SnapshotManifest;
    if (manifest.schemaVersion !== 2 || manifest.identity.id !== id) throw new Error("Invalid snapshot manifest");
    assertSnapshot(manifest.identity);
    if (sha256(manifest.repositoryPath) !== manifest.identity.repositoryId) throw new Error("Repository identity mismatch");
    const baseHash = sha256(JSON.stringify(manifest.base)); const headHash = sha256(JSON.stringify(manifest.head));
    if (manifest.identity.baseVersion?.id !== (manifest.identity.baseCommit ?? baseHash) || manifest.identity.headVersion?.id !== (manifest.identity.headCommit ?? headHash)) throw new Error("Snapshot version mismatch");
    const expectedPaths = [...new Set([...Object.keys(manifest.base), ...Object.keys(manifest.head)])].filter(path => manifest.base[path]?.hash !== manifest.head[path]?.hash || manifest.base[path]?.mode !== manifest.head[path]?.mode).sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(manifest.changedPaths)) throw new Error("Snapshot coverage mismatch");
    const input = sha256(JSON.stringify({ baseHash: sha256(JSON.stringify(manifest.base)), headHash: sha256(JSON.stringify(manifest.head)), kind: manifest.input.kind, baseCommit: manifest.identity.baseCommit, headCommit: manifest.identity.headCommit }));
    if (input !== manifest.identity.inputFingerprint || sha256(manifest.identity.repositoryId + input + manifest.identity.configurationFingerprint) !== id) throw new Error("Snapshot manifest integrity mismatch");
    return new SnapshotStore(stateDir, manifest);
  }
  async text(revision: "base" | "head", path: string): Promise<string> {
    safePath(path);
    const file = this.manifest[revision]?.[path];
    if (!file || file.status !== "text" || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error("Source unavailable or not supported text");
    const text = await readFile(join(this.stateDir, "blobs", file.hash), "utf8");
    if (sha256(text) !== file.hash) throw new Error("Snapshot blob integrity mismatch");
    return text;
  }
  async source(revision: "base" | "head", path: string, startLine = 1, endLine = startLine + 199): Promise<SourcePage> {
    if (!["base", "head"].includes(revision) || !Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine || endLine - startLine > 199) throw new Error("Source requests require 1–200 lines");
    const text = await this.text(revision, path); const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
    if (startLine > lines.length && lines.length > 0) throw new Error("Line range outside source");
    const actualEnd = Math.min(endLine, lines.length); const snippet = lines.slice(startLine - 1, actualEnd).join("\n");
    if (Buffer.byteLength(snippet) > 32_768) throw new Error("Source range exceeds output limit; request fewer lines");
    return { snapshotId: this.manifest.identity.id, revision, path, status: "ok", text: snippet, startLine, endLine: actualEnd, totalLines: lines.length, contentSha256: sha256(snippet), truncated: false, hasMoreLines: actualEnd < lines.length, warnings: [] };
  }
  async read(ref: EvidenceRef): Promise<{ text: string; actualSha256: string }> {
    if (ref.snapshotId !== this.manifest.identity.id) throw new Error("Evidence snapshot mismatch");
    const page = await this.source(ref.revision, ref.path, ref.startLine, ref.endLine);
    if (page.endLine !== ref.endLine) throw new Error("Evidence end exceeds source");
    return { text: page.text, actualSha256: page.contentSha256 };
  }
  async diff(path: string, offset = 0, limit = 100): Promise<{ snapshotId: string; path: string; status: "ok" | "unavailable"; lines: string[]; offset: number; totalLines: number; nextCursor?: number; truncated: boolean; warnings: string[] }> {
    if (!this.manifest.changedPaths.includes(path)) throw new Error("Path is not changed");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid diff page");
    const unsupported = (["base", "head"] as const).some(rev => this.manifest[rev][path] && this.manifest[rev][path]!.status !== "text");
    if (unsupported) return { snapshotId: this.manifest.identity.id, path, status: "unavailable", lines: [], offset: 0, totalLines: 0, truncated: false, warnings: ["Binary, oversized, symlink or submodule change cannot be covered by text review"] };
    const before = this.manifest.base[path] ? await this.text("base", path) : null;
    const after = this.manifest.head[path] ? await this.text("head", path) : null;
    const all = frozenDiff(path, before, after);
    if (this.manifest.base[path]?.mode !== this.manifest.head[path]?.mode) all.unshift(`mode ${this.manifest.base[path]?.mode ?? "absent"} -> ${this.manifest.head[path]?.mode ?? "absent"}`);
    if (all.some(line => Buffer.byteLength(line) > 16_384)) return { snapshotId: this.manifest.identity.id, path, status: "unavailable", lines: [], offset: 0, totalLines: 0, truncated: false, warnings: ["Diff line exceeds output limit"] };
    const selected: string[] = []; let bytes = 0;
    for (const line of all.slice(offset, offset + limit)) { if (bytes + Buffer.byteLength(line) > 32_768) break; selected.push(line); bytes += Buffer.byteLength(line); }
    const next = offset + selected.length; const truncated = next < all.length;
    return { snapshotId: this.manifest.identity.id, path, status: "ok", lines: selected, offset, totalLines: all.length, ...(truncated ? { nextCursor: next } : {}), truncated, warnings: ["Frozen unified diff; widely separated edits may share a coalesced hunk"] };
  }
  async search(revision: "base" | "head", query: string, limit = 50, options: { path?: string; cursor?: string } = {}): Promise<unknown> {
    if (!["base", "head"].includes(revision) || !query || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid literal search");
    const scope = options.path;
    if (scope !== undefined) safePath(scope.endsWith("/") ? scope.slice(0, -1) : scope);
    const paths = Object.keys(this.manifest[revision]).sort().filter(p => scope === undefined || (scope.endsWith("/") ? p.startsWith(scope) : p === scope));
    if (scope !== undefined && !paths.length) throw new Error("Search path is absent from this revision");
    const key = sha256(JSON.stringify([this.manifest.identity.id, revision, query, scope ?? null]));
    let resume: { key: string; path: string; line: number } | undefined;
    if (options.cursor !== undefined) {
      try {
        if (options.cursor.length > 8192) throw new Error();
        resume = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (!resume || resume.key !== key || !paths.includes(resume.path) || !Number.isSafeInteger(resume.line) || resume.line < 1) throw new Error();
      } catch { throw new Error("Invalid search cursor for this snapshot, revision, query or path"); }
    }
    const items: { path: string; line: number; text: string }[] = []; let truncated = false; let scanned = 0; let skipped = 0; let outputBytes = 0;
    let nextCursor: string | undefined;
    for (const path of paths) {
      if (resume && path < resume.path) continue;
      if (this.manifest[revision][path]!.status !== "text") { skipped++; continue; }
      const lines = (await this.text(revision, path)).split("\n"); scanned++;
      const start = resume?.path === path ? resume.line - 1 : 0;
      if (start >= lines.length) throw new Error("Search cursor line outside source");
      for (let i = start; i < lines.length; i++) if (lines[i]!.includes(query)) {
        const item = { path, line: i + 1, text: lines[i]!.slice(0, 500) }; const bytes = Buffer.byteLength(JSON.stringify(item));
        if (items.length >= limit || outputBytes + bytes > 32_768) {
          if (!items.length) throw new Error("Search item exceeds output limit");
          truncated = true; nextCursor = Buffer.from(JSON.stringify({ key, path, line: i + 1 })).toString("base64url"); break;
        }
        items.push(item); outputBytes += bytes;
      }
      if (truncated) break;
    }
    return { snapshotId: this.manifest.identity.id, revision, status: "ok", items, truncated, ...(nextCursor ? { nextCursor } : {}), ...(scope === undefined ? {} : { path: scope }), coverage: { scannedFiles: scanned, skippedFiles: skipped, totalFiles: Object.keys(this.manifest[revision]).length, scopedFiles: paths.length }, warnings: ["Search coverage is per page and scope; omitted or non-text files do not establish absence."] };
  }
}
