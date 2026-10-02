import { DatabaseSync } from "node:sqlite";
import { mkdir, open as openFile, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedState, sha256, writeJson } from "../infrastructure/files.ts";
import { SnapshotStore } from "../snapshot/store.ts";
import { emptyCoverage } from "./contracts.ts";
import type { CodeGraph, GraphCoverage, GraphGenerationState, GraphPage, ImportFact, InheritanceFact, CallSiteFact, RelationFact, Resolution, SymbolFact, SyntaxFacts } from "./contracts.ts";
import { PythonResolver, RESOLVER_VERSION } from "./python-resolver.ts";
import { FILE_SCOPE_POLICY_VERSION, pythonCatalog, pythonModuleName } from "./scope-policy.ts";
import type { GraphScope, PythonCatalogEntry } from "./scope-policy.ts";

export const GRAPH_SCHEMA_VERSION = 4;
export const PARSER_VERSION = "web-tree-sitter-0.27.0/python-0.25.0-abi15";
export const GRAPH_POLICY_VERSION = `python-entity-core-2/${FILE_SCOPE_POLICY_VERSION}`;
export interface GraphBuildBudget { maxFacts: number; maxRelations: number; maxFileFacts: number; maxFileMs: number }
export const DEFAULT_GRAPH_BUDGET: GraphBuildBudget = { maxFacts: 250_000, maxRelations: 400_000, maxFileFacts: 25_000, maxFileMs: 15_000 };
export interface GraphStorageMetrics { generationBytes: number; checkpointBytes: number }
export interface GraphMetrics {
  buildMs: number; queryMs: number; cacheHit: boolean; coverage: GraphCoverage;
  resumedFiles: number; extractedFiles: number; resumedResolutionFiles: number; resolvedFiles: number; storage: GraphStorageMetrics;
  generationId?: string; generationState?: GraphGenerationState; scope?: GraphScope;
}
export interface PublishedManifest {
  manifestVersion: 1; snapshotId: string; cacheIdentity: string; schemaVersion: number;
  resolverVersion: string; parserVersion: string; policyVersion: string; scope: GraphScope; budget: GraphBuildBudget;
  generationId: string; generationState: GraphGenerationState; databaseFile: string; databaseBytes: number;
  coverage: GraphCoverage; warnings: string[];
  counts: { files: number; entities: number; sites: number; relations: number; relationSites: number };
  publishedAt: string;
}
interface CheckpointRow {
  path: string; content_sha256: string; status: "complete" | "incomplete" | "unsupported" | "failed";
  fact_count: number; diagnostics: string; failure_kind: string | null; failure_reason: string | null;
}
interface CheckpointWriteRow extends CheckpointRow { facts: string | null }
interface StoredDependencySite {
  id: string; kind: "call" | "inherit" | "import"; ownerSymbolId: string; path: string; qualifiedName: string;
  startLine: number; endLine: number; startColumn: number; endColumn: number; expression: string;
  resolution: Resolution; candidateTargetIds: string[]; ruleSource?: string; declarationOrder?: number;
}
interface ResolutionCheckpointRow {
  path: string; content_sha256: string; resolver_version: string; site_count: number; relation_count: number;
  sites: string; relations: string; call_counts: string;
}
const warning = "HEAD-only static Python entity graph. Ordinary references are not indexed; dynamic/external calls may be unresolved. Empty results never prove absence. Verify findings using read_source.";
const boundedWarning = (value: string) => value.slice(0, 512);
const graphIdentity = (snapshotId: string, budget: GraphBuildBudget, scope: GraphScope) => sha256(JSON.stringify({ snapshotId, schema: GRAPH_SCHEMA_VERSION, resolver: RESOLVER_VERSION, parser: PARSER_VERSION, policy: GRAPH_POLICY_VERSION, scope, budget }));
export const graphCacheDir = (state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core") => join(state, "graphs", graphIdentity(snapshotId, budget, scope));
export const graphPublishPath = (state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core") => join(graphCacheDir(state, snapshotId, budget, scope), "published.json");
export const graphCheckpointPath = (state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core") => join(graphCacheDir(state, snapshotId, budget, scope), "checkpoint.sqlite");
export const graphBuildLockPath = (state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core") => join(graphCacheDir(state, snapshotId, budget, scope), "build.lock");
const graphFailurePath = (state: string, snapshotId: string, budget: GraphBuildBudget, scope: GraphScope) => join(graphCacheDir(state, snapshotId, budget, scope), "failure.json");

export class GraphOpenError extends Error {
  readonly status: "building" | "error"; readonly coverage: GraphCoverage; readonly warnings: string[];
  constructor(status: "building" | "error", message: string, coverage = emptyCoverage(), warnings = [message]) { super(message); this.status = status; this.coverage = coverage; this.warnings = warnings; }
}

function assertBudget(budget: GraphBuildBudget): void {
  for (const [key, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid graph budget: ${key}`);
}
function factCount(facts: SyntaxFacts): number { return facts.symbols.length + facts.calls.length + facts.inheritances.length + facts.imports.length + facts.scopes.length + facts.bindings.length; }
function dbCount(db: DatabaseSync, table: string): number { return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint }).n); }
async function fileBytes(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
async function checkpointBytes(path: string): Promise<number> { return (await Promise.all([path, `${path}-wal`, `${path}-shm`].map(fileBytes))).reduce((sum, value) => sum + value, 0); }
async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } }
function generationPath(cacheDir: string, manifest: PublishedManifest): string {
  if (!/^generations\/[a-f0-9-]+\.sqlite$/.test(manifest.databaseFile.replaceAll("\\", "/")) || basename(manifest.databaseFile) !== `${manifest.generationId}.sqlite`) throw new Error("Invalid graph generation manifest path");
  return join(cacheDir, "generations", `${manifest.generationId}.sqlite`);
}
async function readPublished(state: string, snapshotId: string, budget: GraphBuildBudget, scope: GraphScope): Promise<PublishedManifest | undefined> {
  const value = await readJson<PublishedManifest>(graphPublishPath(state, snapshotId, budget, scope));
  if (!value) return;
  const identity = graphIdentity(snapshotId, budget, scope);
  if (value.manifestVersion !== 1 || value.snapshotId !== snapshotId || value.cacheIdentity !== identity || value.schemaVersion !== GRAPH_SCHEMA_VERSION || value.resolverVersion !== RESOLVER_VERSION || value.parserVersion !== PARSER_VERSION || value.policyVersion !== GRAPH_POLICY_VERSION || value.scope !== scope || JSON.stringify(value.budget) !== JSON.stringify(budget)) throw new Error("Graph publish manifest identity mismatch");
  generationPath(graphCacheDir(state, snapshotId, budget, scope), value);
  return value;
}
export async function publishedGraphPath(state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core"): Promise<string> {
  const manifest = await readPublished(state, snapshotId, budget, scope); if (!manifest) throw Object.assign(new Error("No published graph generation"), { code: "ENOENT" });
  return generationPath(graphCacheDir(state, snapshotId, budget, scope), manifest);
}
async function syncFile(path: string): Promise<void> { const handle = await openFile(path, "r+"); try { await handle.sync(); } finally { await handle.close(); } }

async function quarantinePublished(state: string, snapshotId: string, budget: GraphBuildBudget, scope: GraphScope, manifest?: PublishedManifest): Promise<void> {
  const cache = graphCacheDir(state, snapshotId, budget, scope); const quarantine = join(cache, "quarantine"); await mkdir(quarantine, { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${randomUUID()}`;
  if (manifest) await rename(generationPath(cache, manifest), join(quarantine, `${manifest.generationId}-${suffix}.sqlite`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await rename(graphPublishPath(state, snapshotId, budget, scope), join(quarantine, `published-${suffix}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function acquireBuildLock(path: string, ownerToken: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await openFile(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken, createdAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new GraphOpenError("building", "Graph build is already in progress; no unpublished checkpoint is queryable.");
  }
}
export async function releaseGraphBuildLock(state: string, snapshotId: string, ownerToken: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core"): Promise<void> {
  const path = graphBuildLockPath(state, snapshotId, budget, scope);
  try { const value = JSON.parse(await readFile(path, "utf8")) as { ownerToken?: string }; if (value.ownerToken === ownerToken) await rm(path, { force: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function openCheckpoint(path: string): DatabaseSync { return new DatabaseSync(path); }
function checkpointRows(db: DatabaseSync, identity: string): CheckpointRow[] { return db.prepare("SELECT path,content_sha256,status,fact_count,diagnostics,failure_kind,failure_reason FROM file_checkpoints WHERE cache_identity=? ORDER BY path").all(identity) as unknown as CheckpointRow[]; }
function checkpointFact(db: DatabaseSync, identity: string, path: string): SyntaxFacts {
  const row = db.prepare("SELECT facts FROM file_checkpoints WHERE cache_identity=? AND path=?").get(identity, path) as { facts: string | null } | undefined;
  if (!row?.facts) throw new Error(`Missing extraction checkpoint facts: ${path}`); return JSON.parse(row.facts) as SyntaxFacts;
}
function commitCheckpoint(db: DatabaseSync, identity: string, row: CheckpointWriteRow): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO file_checkpoints(cache_identity,path,content_sha256,status,fact_count,facts,diagnostics,failure_kind,failure_reason,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(identity, row.path, row.content_sha256, row.status, row.fact_count, row.facts, row.diagnostics, row.failure_kind, row.failure_reason, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; }
}
function setBuildState(db: DatabaseSync, identity: string, state: "building" | "resolving" | "publishing" | "complete" | "error", failureKind?: string, failureReason?: string): void {
  db.prepare("UPDATE graph_builds SET state=?,failure_kind=?,failure_reason=?,updated_at=? WHERE cache_identity=?").run(state, failureKind ?? null, failureReason ?? null, new Date().toISOString(), identity);
}
function resolutionRows(db: DatabaseSync, identity: string): Omit<ResolutionCheckpointRow, "sites" | "relations" | "call_counts">[] {
  return db.prepare("SELECT path,content_sha256,resolver_version,site_count,relation_count FROM resolution_checkpoints WHERE cache_identity=? ORDER BY path").all(identity) as unknown as Omit<ResolutionCheckpointRow, "sites" | "relations" | "call_counts">[];
}
function resolutionCheckpoint(db: DatabaseSync, identity: string, path: string): ResolutionCheckpointRow {
  const row = db.prepare("SELECT path,content_sha256,resolver_version,site_count,relation_count,sites,relations,call_counts FROM resolution_checkpoints WHERE cache_identity=? AND path=?").get(identity, path) as unknown as ResolutionCheckpointRow | undefined;
  if (!row) throw new Error(`Missing relation checkpoint: ${path}`); return row;
}
function commitResolutionCheckpoint(db: DatabaseSync, identity: string, row: ResolutionCheckpointRow): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO resolution_checkpoints(cache_identity,path,content_sha256,resolver_version,site_count,relation_count,sites,relations,call_counts,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(identity, row.path, row.content_sha256, row.resolver_version, row.site_count, row.relation_count, row.sites, row.relations, row.call_counts, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; }
}
function excludedCount(catalog: PythonCatalogEntry[], classification: PythonCatalogEntry["classification"]): number { return catalog.filter(entry => !entry.included && entry.classification === classification).length; }
function storedSites(fact: SyntaxFacts, relations: RelationFact[]): StoredDependencySite[] {
  const bySite = new Map<string, RelationFact[]>(); for (const edge of relations) bySite.set(edge.siteId, [...bySite.get(edge.siteId) ?? [], edge]);
  const source = (site: CallSiteFact | InheritanceFact, kind: "call" | "inherit"): StoredDependencySite => ({
    id: site.id, kind, ownerSymbolId: site.ownerSymbolId, path: site.path, qualifiedName: site.qualifiedName,
    startLine: site.startLine, endLine: site.endLine, startColumn: site.startColumn, endColumn: site.endColumn,
    expression: site.expression, resolution: site.resolution, candidateTargetIds: site.candidateTargetIds,
    ...(site.ruleSource ? { ruleSource: site.ruleSource } : {}), ...("declarationOrder" in site ? { declarationOrder: site.declarationOrder } : {}),
  });
  const imported = (site: ImportFact): StoredDependencySite => {
    const edges = bySite.get(site.id) ?? []; const resolution = edges[0]?.resolution ?? "unresolved";
    return { id: site.id, kind: "import", ownerSymbolId: site.scopeId, path: site.path, qualifiedName: site.qualifiedName,
      startLine: site.startLine, endLine: site.endLine, startColumn: site.startColumn, endColumn: site.endColumn,
      expression: site.importedName ? `${site.module}.${site.importedName}` : site.module, resolution,
      candidateTargetIds: [...new Set(edges.map(edge => edge.toId))], ruleSource: edges.length ? "explicit_import_binding" : "module_not_indexed" };
  };
  return [...fact.calls.map(site => source(site, "call")), ...fact.inheritances.map(site => source(site, "inherit")), ...fact.imports.map(imported)];
}
function relationAggregateId(snapshotId: string, edge: RelationFact): string { return sha256(JSON.stringify([snapshotId, edge.fromId, edge.toId, edge.relation, edge.resolution, RESOLVER_VERSION])); }

type EntityRow = Record<string, unknown>;
function entityFromRow(row: EntityRow): SymbolFact {
  return {
    id: String(row.entity_id), snapshotId: String(row.snapshot_id), kind: String(row.kind) as SymbolFact["kind"],
    ...(row.function_kind === null || row.function_kind === undefined ? {} : { functionKind: String(row.function_kind) as "function" | "method" }),
    path: String(row.path), qualifiedName: String(row.qualified_name), name: String(row.name),
    startLine: Number(row.start_line), endLine: Number(row.end_line), startColumn: Number(row.start_column), endColumn: Number(row.end_column),
    ...(row.parent_entity_id === null || row.parent_entity_id === undefined ? {} : { parentSymbolId: String(row.parent_entity_id) }),
  };
}
function relationFromRow(row: Record<string, unknown>): RelationFact {
  const siteId = String(row.site_id);
  return {
    id: sha256(JSON.stringify([row.relation_id, siteId])), snapshotId: String(row.snapshot_id), fromId: String(row.source_entity_id), toId: String(row.target_entity_id),
    relation: String(row.kind) as RelationFact["relation"], resolution: String(row.resolution) as Resolution,
    sourcePath: String(row.source_path), sourceLine: Number(row.source_line), sourceEndLine: Number(row.source_end_line), sourceColumn: Number(row.source_column), sourceEndColumn: Number(row.source_end_column),
    siteId, resolverVersion: String(row.resolver_version), siteCount: Number(row.site_count),
    ...(row.declaration_order === null || row.declaration_order === undefined ? {} : { declarationOrder: Number(row.declaration_order) }),
  };
}
const relationSelect = `SELECT r.snapshot_id,r.relation_id,r.source_entity_id,r.target_entity_id,r.kind,r.resolution,r.resolver_version,r.site_count,rs.site_id,rs.path AS source_path,rs.start_line AS source_line,rs.end_line AS source_end_line,rs.start_column AS source_column,rs.end_column AS source_end_column,rs.declaration_order FROM relations r JOIN relation_sites rs ON rs.snapshot_id=r.snapshot_id AND rs.relation_id=r.relation_id`;
export function readGraphEntities(db: DatabaseSync, snapshotId: string): SymbolFact[] {
  return (db.prepare("SELECT snapshot_id,entity_id,kind,function_kind,path,qualified_name,name,start_line,end_line,start_column,end_column,parent_entity_id FROM entities WHERE snapshot_id=? ORDER BY entity_id").all(snapshotId) as EntityRow[]).map(entityFromRow);
}
export function readGraphRelations(db: DatabaseSync, snapshotId: string): RelationFact[] {
  const sql = `${relationSelect} WHERE r.snapshot_id=? AND rs.site_id=(SELECT min(rs2.site_id) FROM relation_sites rs2 WHERE rs2.snapshot_id=r.snapshot_id AND rs2.relation_id=r.relation_id) ORDER BY r.relation_id`;
  return (db.prepare(sql).all(snapshotId) as Record<string, unknown>[]).map(relationFromRow);
}
function metricsForPublished(_state: string, _snapshotId: string, _budget: GraphBuildBudget, scope: GraphScope, manifest: PublishedManifest, checkpoint: number): GraphMetrics {
  return { buildMs: 0, queryMs: 0, cacheHit: true, coverage: manifest.coverage, resumedFiles: 0, extractedFiles: 0, resumedResolutionFiles: 0, resolvedFiles: 0, storage: { generationBytes: manifest.databaseBytes, checkpointBytes: checkpoint }, generationId: manifest.generationId, generationState: manifest.generationState, scope };
}

/** Immutable, already-published graph generation. */
export class SqliteCodeGraph implements CodeGraph {
  private db: DatabaseSync; private snapshotId: string; private coverage: GraphCoverage; private warnings: string[];
  private generationId: string; private generationState: GraphGenerationState;
  private constructor(db: DatabaseSync, manifest: PublishedManifest) { this.db = db; this.snapshotId = manifest.snapshotId; this.coverage = manifest.coverage; this.warnings = manifest.warnings; this.generationId = manifest.generationId; this.generationState = manifest.generationState; }

  private static async openPublished(state: string, snapshotId: string, budget: GraphBuildBudget, scope: GraphScope, manifest: PublishedManifest): Promise<SqliteCodeGraph> {
    const path = generationPath(graphCacheDir(state, snapshotId, budget, scope), manifest); const info = await stat(path);
    if (info.size !== manifest.databaseBytes) throw new Error("Published graph size changed");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
      const meta = db.prepare("SELECT schema_version,resolver_version,parser_version,policy_version,graph_scope,revision,state,cache_identity,generation_id,coverage,warnings FROM graph_snapshots WHERE snapshot_id=?").get(snapshotId) as Record<string, unknown> | undefined;
      const validMeta = meta && meta.schema_version === GRAPH_SCHEMA_VERSION && meta.resolver_version === RESOLVER_VERSION && meta.parser_version === PARSER_VERSION && meta.policy_version === GRAPH_POLICY_VERSION && meta.graph_scope === scope && meta.revision === "head" && meta.cache_identity === manifest.cacheIdentity && meta.generation_id === manifest.generationId && meta.state === manifest.generationState && meta.coverage === JSON.stringify(manifest.coverage) && meta.warnings === JSON.stringify(manifest.warnings);
      if (!validMeta || JSON.stringify(db.prepare("PRAGMA quick_check").all()) !== '[{"quick_check":"ok"}]' || db.prepare("PRAGMA foreign_key_check").all().length || dbCount(db, "files") !== manifest.counts.files || dbCount(db, "entities") !== manifest.counts.entities || dbCount(db, "dependency_sites") !== manifest.counts.sites || dbCount(db, "relations") !== manifest.counts.relations || dbCount(db, "relation_sites") !== manifest.counts.relationSites) throw new Error("Published graph validation failed");
      return new SqliteCodeGraph(db, manifest);
    } catch (error) { db.close(); throw error; }
  }

  static async open(store: SnapshotStore, options: { budget?: GraphBuildBudget; ownerToken?: string; scope?: GraphScope; testFault?: "publish_enospc" } = {}): Promise<{ graph: SqliteCodeGraph; metrics: GraphMetrics }> {
    const started = performance.now(); const id = store.manifest.identity.id; const budget = options.budget ?? DEFAULT_GRAPH_BUDGET; const scope = options.scope ?? "core"; assertBudget(budget);
    await isolatedState(store.stateDir, store.manifest.repositoryPath);
    const cache = graphCacheDir(store.stateDir, id, budget, scope); await mkdir(join(cache, "generations"), { recursive: true, mode: 0o700 });
    let published: PublishedManifest | undefined;
    try {
      published = await readPublished(store.stateDir, id, budget, scope);
      if (published) {
        const graph = await this.openPublished(store.stateDir, id, budget, scope, published);
        return { graph, metrics: metricsForPublished(store.stateDir, id, budget, scope, published, await checkpointBytes(graphCheckpointPath(store.stateDir, id, budget, scope))) };
      }
    } catch {
      await quarantinePublished(store.stateDir, id, budget, scope, published);
    }
    const knownFailure = await readJson<{ cacheIdentity: string; reason: string; coverage: GraphCoverage; warnings: string[] }>(graphFailurePath(store.stateDir, id, budget, scope));
    if (knownFailure?.cacheIdentity === graphIdentity(id, budget, scope)) throw new GraphOpenError("error", knownFailure.reason, knownFailure.coverage, knownFailure.warnings);

    const ownerToken = options.ownerToken ?? randomUUID(); const lock = graphBuildLockPath(store.stateDir, id, budget, scope); await acquireBuildLock(lock, ownerToken);
    try {
      const raced = await readPublished(store.stateDir, id, budget, scope);
      if (raced) {
        const graph = await this.openPublished(store.stateDir, id, budget, scope, raced);
        return { graph, metrics: metricsForPublished(store.stateDir, id, budget, scope, raced, await checkpointBytes(graphCheckpointPath(store.stateDir, id, budget, scope))) };
      }
      return await this.build(store, budget, scope, started, options.testFault);
    } finally { await releaseGraphBuildLock(store.stateDir, id, ownerToken, budget, scope); }
  }

  /** Evaluation-only: validate and open an already published generation without
   * creating directories, quarantining data, acquiring a builder lock, or rebuilding. */
  static async openPublishedOnly(store: SnapshotStore, options: { budget?: GraphBuildBudget; scope?: GraphScope } = {}): Promise<{ graph: SqliteCodeGraph; metrics: GraphMetrics; manifest: PublishedManifest }> {
    const id = store.manifest.identity.id; const budget = options.budget ?? DEFAULT_GRAPH_BUDGET; const scope = options.scope ?? "core"; assertBudget(budget);
    let manifest: PublishedManifest | undefined;
    try {
      manifest = await readPublished(store.stateDir, id, budget, scope);
      if (!manifest) throw new Error("No published graph generation");
      const graph = await this.openPublished(store.stateDir, id, budget, scope, manifest);
      const bytes = await checkpointBytes(graphCheckpointPath(store.stateDir, id, budget, scope));
      return { graph, metrics: metricsForPublished(store.stateDir, id, budget, scope, manifest, bytes), manifest };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Published graph validation failed";
      throw new GraphOpenError("error", `Prepared-only graph open failed: ${reason}`, manifest?.coverage ?? emptyCoverage(), [...(manifest?.warnings ?? []), "Prepared-only evaluation never rebuilds a missing or invalid generation."]);
    }
  }

  private static async build(store: SnapshotStore, budget: GraphBuildBudget, scope: GraphScope, started: number, testFault?: "publish_enospc"): Promise<{ graph: SqliteCodeGraph; metrics: GraphMetrics }> {
    const id = store.manifest.identity.id; const identity = graphIdentity(id, budget, scope); const stagingPath = graphCheckpointPath(store.stateDir, id, budget, scope);
    const staging = openCheckpoint(stagingPath); let extractedFiles = 0; let resumedFiles = 0; let resumedResolutionFiles = 0; let resolvedFiles = 0; let extractor: { extract(input: { snapshotId: string; path: string; source: string }, limits?: { maxFacts?: number; deadline?: number }): Promise<SyntaxFacts>; dispose(): void } | undefined;
    try {
      staging.exec(await readFile(new URL("../../schemas/graph-checkpoint.sql", import.meta.url), "utf8"));
      const now = new Date().toISOString();
      staging.prepare("INSERT OR IGNORE INTO graph_builds(cache_identity,snapshot_id,schema_version,resolver_version,parser_version,policy_version,budget,state,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(identity, id, GRAPH_SCHEMA_VERSION, RESOLVER_VERSION, PARSER_VERSION, GRAPH_POLICY_VERSION, JSON.stringify({ scope, ...budget }), "building", 0, now, now);
      const build = staging.prepare("SELECT snapshot_id,schema_version,resolver_version,parser_version,policy_version,budget FROM graph_builds WHERE cache_identity=?").get(identity) as Record<string, unknown>;
      if (build.snapshot_id !== id || build.schema_version !== GRAPH_SCHEMA_VERSION || build.resolver_version !== RESOLVER_VERSION || build.parser_version !== PARSER_VERSION || build.policy_version !== GRAPH_POLICY_VERSION || build.budget !== JSON.stringify({ scope, ...budget })) throw new Error("Checkpoint identity mismatch");
      staging.prepare("UPDATE graph_builds SET state='building',attempts=attempts+1,failure_kind=NULL,failure_reason=NULL,updated_at=? WHERE cache_identity=?").run(now, identity);

      const catalog = pythonCatalog(store.manifest.head, store.manifest.changedPaths, scope); const included = catalog.filter(entry => entry.included); const paths = included.map(entry => entry.path); const includedPaths = new Set(paths);
      let rows = checkpointRows(staging, identity);
      for (const row of rows) if (!includedPaths.has(row.path) || !store.manifest.head[row.path] || store.manifest.head[row.path]!.hash !== row.content_sha256) {
        staging.prepare("DELETE FROM resolution_checkpoints WHERE cache_identity=? AND path=?").run(identity, row.path); staging.prepare("DELETE FROM file_checkpoints WHERE cache_identity=? AND path=?").run(identity, row.path);
      }
      rows = checkpointRows(staging, identity); const existing = new Map(rows.map(row => [row.path, row]));
      resumedFiles = rows.filter(row => row.status === "complete" || row.status === "incomplete").length;
      let totalFacts = rows.reduce((sum, row) => sum + row.fact_count, 0); let limitReason: string | undefined;
      const { PythonTreeSitterExtractor } = await import("../../integrations/tree-sitter/src/python-extractor.ts"); extractor = await PythonTreeSitterExtractor.create();
      for (const path of paths) {
        if (existing.has(path)) continue;
        const frozen = store.manifest.head[path]!;
        if (frozen.status !== "text") { commitCheckpoint(staging, identity, { path, content_sha256: frozen.hash, status: "unsupported", fact_count: 0, facts: null, diagnostics: "[]", failure_kind: "invalid_source", failure_reason: "Unsupported snapshot file" }); continue; }
        let facts: SyntaxFacts;
        try { facts = await extractor.extract({ snapshotId: id, path, source: await store.text("head", path) }, { maxFacts: budget.maxFileFacts, deadline: performance.now() + budget.maxFileMs }); }
        catch (error) {
          const reason = error instanceof Error ? error.message : "Extraction failed"; const deterministic = reason.includes("per-file extraction");
          if (!deterministic) throw error;
          commitCheckpoint(staging, identity, { path, content_sha256: frozen.hash, status: "failed", fact_count: 0, facts: null, diagnostics: "[]", failure_kind: "capacity", failure_reason: boundedWarning(reason) }); continue;
        }
        const count = factCount(facts);
        if (totalFacts + count > budget.maxFacts) { limitReason = `Graph fact budget reached before ${path}`; break; }
        commitCheckpoint(staging, identity, { path, content_sha256: frozen.hash, status: facts.parseComplete ? "complete" : "incomplete", fact_count: count, facts: JSON.stringify(facts), diagnostics: JSON.stringify(facts.diagnostics), failure_kind: null, failure_reason: null });
        totalFacts += count; extractedFiles++;
      }
      extractor.dispose(); extractor = undefined;
      rows = checkpointRows(staging, identity); const rowMap = new Map(rows.map(row => [row.path, row]));
      const parsedRows = rows.filter(row => row.status === "complete" || row.status === "incomplete");
      const coverage = emptyCoverage(); coverage.totalLanguageFiles = catalog.length; coverage.eligibleFiles = paths.length; coverage.plannedFiles = paths.length; coverage.indexedFiles = parsedRows.length;
      coverage.changedCoreFiles = included.filter(entry => entry.layer === "changed").length; coverage.productionCoreFiles = included.filter(entry => entry.layer === "production").length;
      coverage.excludedTestFiles = excludedCount(catalog, "test"); coverage.excludedExampleFiles = excludedCount(catalog, "example"); coverage.excludedBenchmarkFiles = excludedCount(catalog, "benchmark"); coverage.excludedGeneratedFiles = excludedCount(catalog, "generated"); coverage.excludedVendorFiles = excludedCount(catalog, "vendor");
      coverage.parseIncompleteFiles = rows.filter(row => row.status === "incomplete").length; coverage.unsupportedFiles = rows.filter(row => row.status === "unsupported").length; coverage.failedFiles = rows.filter(row => row.status === "failed").length;
      coverage.omittedFiles = Math.max(0, paths.length - rows.length); if (limitReason) coverage.limitReason = limitReason;
      const checkpointedPaths = new Set(rows.map(row => row.path)); coverage.omittedChangedFiles = included.filter(entry => entry.layer === "changed" && !checkpointedPaths.has(entry.path)).length; coverage.omittedProductionFiles = included.filter(entry => entry.layer === "production" && !checkpointedPaths.has(entry.path)).length;
      const warnings = [warning]; const excluded = catalog.length - paths.length;
      if (excluded) warnings.push(`Core scope intentionally excluded ${excluded} unchanged test/example/benchmark/generated/vendor Python files; request scope=all for an explicit supplemental graph.`);
      for (const row of rows) {
        for (const diagnostic of JSON.parse(row.diagnostics) as string[]) if (warnings.length < 50) warnings.push(`${row.path.slice(0, 256)}: ${boundedWarning(diagnostic)}`);
        if (row.failure_reason && warnings.length < 50) warnings.push(`${row.path.slice(0, 256)}: ${boundedWarning(row.failure_reason)}`);
      }
      if (limitReason) warnings.push(`${limitReason}. Only complete committed files were considered for partial publication.`);
      if (coverage.parseIncompleteFiles) warnings.push("Parse-incomplete files contribute declarations but no proven semantic edges.");
      if (coverage.unsupportedFiles || coverage.failedFiles || coverage.omittedFiles) warnings.push("Coverage is partial. Empty caller results cannot establish repository-wide absence.");
      setBuildState(staging, identity, "resolving");
      const resolver = new PythonResolver(id); let structuralRelations: RelationFact[] = [];
      try {
        // Pass 1 retains only declarations/bindings needed for cross-file resolution.
        const parsedPaths = new Set(parsedRows.map(row => row.path)); for (const entry of catalog) if (!parsedPaths.has(entry.path)) resolver.markModuleUnavailable(pythonModuleName(entry.path));
        for (const row of parsedRows) resolver.index(checkpointFact(staging, identity, row.path));
        resolver.finalize(); structuralRelations = resolver.structuralRelations(); let relationFacts = structuralRelations.length;
        let resolutionMeta = resolutionRows(staging, identity); const validRows = new Map(parsedRows.map(row => [row.path, row]));
        for (const item of resolutionMeta) {
          const extraction = validRows.get(item.path);
          if (!extraction || extraction.content_sha256 !== item.content_sha256 || item.resolver_version !== RESOLVER_VERSION) staging.prepare("DELETE FROM resolution_checkpoints WHERE cache_identity=? AND path=?").run(identity, item.path);
        }
        resolutionMeta = resolutionRows(staging, identity); const existingResolution = new Map(resolutionMeta.map(row => [row.path, row]));
        for (const row of parsedRows) {
          const cached = existingResolution.get(row.path);
          if (cached) { relationFacts += Number(cached.relation_count); resumedResolutionFiles++; }
          else {
            const fact = checkpointFact(staging, identity, row.path); const relations = resolver.resolveFile(fact); relationFacts += relations.length;
            if (relationFacts > budget.maxRelations) throw new Error("Graph relation limit exceeded");
            const sites = storedSites(fact, relations); const counts = { resolved: 0, candidate: 0, unresolved: 0 };
            for (const call of fact.calls) if (call.resolution === "candidate") counts.candidate++; else if (call.resolution === "unresolved") counts.unresolved++; else counts.resolved++;
            commitResolutionCheckpoint(staging, identity, { path: row.path, content_sha256: row.content_sha256, resolver_version: RESOLVER_VERSION, site_count: sites.length, relation_count: relations.length, sites: JSON.stringify(sites), relations: JSON.stringify(relations), call_counts: JSON.stringify(counts) }); resolvedFiles++;
          }
          if (relationFacts > budget.maxRelations) throw new Error("Graph relation limit exceeded");
        }
      }
      catch (error) {
        const reason = error instanceof Error ? error.message : "Resolver failed"; const deterministic = reason.includes("limit exceeded");
        setBuildState(staging, identity, "error", deterministic ? "capacity" : "internal", boundedWarning(reason));
        if (deterministic) await writeJson(graphFailurePath(store.stateDir, id, budget, scope), { cacheIdentity: identity, kind: "capacity", reason, coverage, warnings: [...warnings, reason], failedAt: new Date().toISOString() });
        throw error;
      }
      const resolvedRows = resolutionRows(staging, identity);
      for (const row of resolvedRows) {
        const counts = JSON.parse(resolutionCheckpoint(staging, identity, row.path).call_counts) as { resolved: number; candidate: number; unresolved: number };
        coverage.resolvedCalls += counts.resolved; coverage.candidateCalls += counts.candidate; coverage.unresolvedCalls += counts.unresolved;
      }
      const entities = resolver.entities; coverage.entityCount = entities.length; coverage.callSiteCount = coverage.resolvedCalls + coverage.candidateCalls + coverage.unresolvedCalls;
      if (coverage.unresolvedCalls || coverage.candidateCalls) warnings.push("Unresolved/candidate call sites are retained as diagnostics but excluded from proven CALLS traversal.");
      const generationState: GraphGenerationState = coverage.parseIncompleteFiles || coverage.unsupportedFiles || coverage.failedFiles || coverage.omittedFiles ? "partial" : "ready"; coverage.generationState = generationState;
      setBuildState(staging, identity, "publishing");

      const generationId = randomUUID(); const cache = graphCacheDir(store.stateDir, id, budget, scope); const candidate = join(cache, "generations", `${generationId}.sqlite`);
      const counts: PublishedManifest["counts"] = { files: catalog.length, entities: entities.length, sites: resolvedRows.reduce((sum, row) => sum + Number(row.site_count), 0), relations: 0, relationSites: 0 };
      const db = new DatabaseSync(candidate);
      try {
        db.exec(await readFile(new URL("../../schemas/graph.sql", import.meta.url), "utf8")); db.exec("BEGIN IMMEDIATE");
        db.prepare("INSERT INTO graph_snapshots(snapshot_id,schema_version,resolver_version,parser_version,policy_version,graph_scope,revision,state,cache_identity,generation_id,coverage,warnings,file_count,entity_count,site_count,relation_count,relation_site_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, GRAPH_SCHEMA_VERSION, RESOLVER_VERSION, PARSER_VERSION, GRAPH_POLICY_VERSION, scope, "head", generationState, identity, generationId, "{}", "[]", counts.files, counts.entities, counts.sites, 0, 0, new Date().toISOString());
        db.exec("CREATE TEMP TABLE raw_edges(relation_id TEXT NOT NULL,site_id TEXT NOT NULL,path TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,start_column INTEGER NOT NULL,end_column INTEGER NOT NULL,declaration_order INTEGER,source_entity_id TEXT NOT NULL,target_entity_id TEXT NOT NULL,kind TEXT NOT NULL,resolution TEXT NOT NULL,resolver_version TEXT NOT NULL,PRIMARY KEY(relation_id,site_id))");
        const fileInsert = db.prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?,?)"); const entityInsert = db.prepare("INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
        const siteInsert = db.prepare("INSERT INTO dependency_sites VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"); const rawInsert = db.prepare("INSERT OR IGNORE INTO raw_edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"); const relationInsert = db.prepare("INSERT INTO relations VALUES(?,?,?,?,?,?,?,?)");
        const writeRaw = (edge: RelationFact) => { if (edge.resolution === "resolved_scoped" || edge.resolution === "resolved_import_alias") rawInsert.run(relationAggregateId(id, edge), edge.siteId, edge.sourcePath, edge.sourceLine, edge.sourceEndLine, edge.sourceColumn, edge.sourceEndColumn, edge.declarationOrder ?? null, edge.fromId, edge.toId, edge.relation, edge.resolution, edge.resolverVersion); };
        const fileLines = new Map(entities.filter(entity => entity.kind === "file").map(entity => [entity.path, entity.endLine]));
        for (const entry of catalog) {
          const row = rowMap.get(entry.path); const status = entry.included ? row?.status ?? "omitted" : "excluded";
          fileInsert.run(id, entry.path, store.manifest.head[entry.path]!.hash, entry.classification, entry.layer, entry.included ? 1 : 0, status, fileLines.get(entry.path) ?? null);
        }
        for (const entity of entities) entityInsert.run(id, entity.id, entity.kind, entity.functionKind ?? null, entity.path, entity.qualifiedName, entity.name, entity.startLine, entity.endLine, entity.startColumn, entity.endColumn, entity.parentSymbolId ?? null);
        for (const edge of structuralRelations) writeRaw(edge);
        for (const row of resolvedRows) {
          const checkpoint = resolutionCheckpoint(staging, identity, row.path); const sites = JSON.parse(checkpoint.sites) as StoredDependencySite[];
          for (const site of sites) siteInsert.run(id, site.id, site.kind, site.ownerSymbolId, site.path, site.qualifiedName, site.startLine, site.endLine, site.startColumn, site.endColumn, site.expression, site.resolution, JSON.stringify(site.candidateTargetIds), site.ruleSource ?? null, site.declarationOrder ?? null);
          for (const edge of JSON.parse(checkpoint.relations) as RelationFact[]) writeRaw(edge);
        }
        const grouped = db.prepare("SELECT relation_id,source_entity_id,target_entity_id,kind,resolution,resolver_version,count(*) AS site_count FROM raw_edges GROUP BY relation_id,source_entity_id,target_entity_id,kind,resolution,resolver_version ORDER BY relation_id");
        for (const edge of grouped.iterate() as Iterable<Record<string, string | number | bigint | null>>) {
          relationInsert.run(id, String(edge.relation_id), String(edge.source_entity_id), String(edge.target_entity_id), String(edge.kind), String(edge.resolution), String(edge.resolver_version), Number(edge.site_count));
        }
        db.prepare("INSERT INTO relation_sites(snapshot_id,relation_id,site_id,path,start_line,end_line,start_column,end_column,declaration_order) SELECT ?,relation_id,site_id,path,start_line,end_line,start_column,end_column,declaration_order FROM raw_edges ORDER BY relation_id,site_id").run(id);
        counts.relations = dbCount(db, "relations"); counts.relationSites = dbCount(db, "relation_sites"); coverage.relationCount = counts.relations;
        db.prepare("UPDATE graph_snapshots SET coverage=?,warnings=?,relation_count=?,relation_site_count=? WHERE snapshot_id=?").run(JSON.stringify(coverage), JSON.stringify(warnings), counts.relations, counts.relationSites, id);
        const invalidRanges = Number((db.prepare("SELECT count(*) AS n FROM entities e LEFT JOIN files f ON f.snapshot_id=e.snapshot_id AND f.path=e.path WHERE e.kind<>'directory' AND (f.path IS NULL OR f.included<>1 OR f.line_count IS NULL OR e.end_line>f.line_count)").get() as { n: number | bigint }).n);
        if (db.prepare("PRAGMA foreign_key_check").all().length || invalidRanges || dbCount(db, "files") !== counts.files || dbCount(db, "entities") !== counts.entities || dbCount(db, "dependency_sites") !== counts.sites || dbCount(db, "relations") !== counts.relations || dbCount(db, "relation_sites") !== counts.relationSites || counts.entities !== coverage.entityCount || counts.relations !== coverage.relationCount) throw new Error("Graph integrity check failed");
        if (testFault === "publish_enospc") throw Object.assign(new Error("Graph publish failed: simulated disk full"), { code: "ENOSPC" });
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original */ } db.close(); await rm(candidate, { force: true });
        const reason = error instanceof Error ? error.message : "Graph publication failed"; setBuildState(staging, identity, "error", (error as NodeJS.ErrnoException).code === "ENOSPC" ? "transient" : "internal", boundedWarning(reason)); throw error;
      }
      db.close(); await syncFile(candidate); const databaseBytes = await fileBytes(candidate);
      const manifest: PublishedManifest = { manifestVersion: 1, snapshotId: id, cacheIdentity: identity, schemaVersion: GRAPH_SCHEMA_VERSION, resolverVersion: RESOLVER_VERSION, parserVersion: PARSER_VERSION, policyVersion: GRAPH_POLICY_VERSION, scope, budget, generationId, generationState, databaseFile: `generations/${generationId}.sqlite`, databaseBytes, coverage, warnings, counts, publishedAt: new Date().toISOString() };
      await writeJson(graphPublishPath(store.stateDir, id, budget, scope), manifest); setBuildState(staging, identity, "complete"); staging.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const graph = await this.openPublished(store.stateDir, id, budget, scope, manifest);
      return { graph, metrics: { buildMs: performance.now() - started, queryMs: 0, cacheHit: false, coverage, resumedFiles, extractedFiles, resumedResolutionFiles, resolvedFiles, storage: { generationBytes: databaseBytes, checkpointBytes: await checkpointBytes(stagingPath) }, generationId, generationState, scope } };
    } finally { extractor?.dispose(); staging.close(); }
  }

  close(): void { this.db.close(); }
  private page<T>(input: { snapshotId: string; limit: number; cursor?: string }, key: unknown, query: (offset: number) => T[]): GraphPage<T> {
    if (input.snapshotId !== this.snapshotId) throw new Error("Graph snapshot mismatch");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Graph limit must be 1..100");
    const fingerprint = sha256(JSON.stringify([this.snapshotId, this.generationId, GRAPH_SCHEMA_VERSION, RESOLVER_VERSION, key])); let offset = 0;
    if (input.cursor) {
      if (input.cursor.length > 256) throw new Error("Invalid graph cursor"); const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (parsed.key !== fingerprint || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error("Graph cursor belongs to another query/snapshot/generation"); offset = parsed.offset;
    }
    const rows = query(offset); const items: T[] = []; let bytes = 0;
    for (const row of rows.slice(0, input.limit)) { const itemBytes = Buffer.byteLength(JSON.stringify(row)); if (bytes + itemBytes > 32_768) break; items.push(row); bytes += itemBytes; }
    if (!items.length && rows.length) throw new Error("Graph item exceeds output limit"); const truncated = rows.length > items.length;
    const status = this.coverage.parseIncompleteFiles ? "parse_incomplete" : this.generationState === "partial" ? "partial" : this.coverage.unsupportedFiles || !this.coverage.eligibleFiles ? "unsupported" : "ok";
    return { snapshotId: this.snapshotId, revision: "head", status, generationId: this.generationId, generationState: this.generationState, items, truncated, ...(truncated ? { nextCursor: Buffer.from(JSON.stringify({ key: fingerprint, offset: offset + items.length })).toString("base64url") } : {}), coverage: this.coverage, warnings: this.warnings };
  }
  async lookup(input: Parameters<CodeGraph["lookup"]>[0]): Promise<GraphPage<SymbolFact>> {
    if (!input.query.trim() || input.query.length > 256) throw new Error("Invalid graph lookup");
    return this.page(input, ["lookup", input.query], offset => (this.db.prepare("SELECT snapshot_id,entity_id,kind,function_kind,path,qualified_name,name,start_line,end_line,start_column,end_column,parent_entity_id FROM entities WHERE snapshot_id=? AND (entity_id=? OR name=? OR qualified_name=? OR path=?) ORDER BY entity_id LIMIT ? OFFSET ?").all(this.snapshotId, input.query, input.query, input.query, input.query, input.limit + 1, offset) as EntityRow[]).map(entityFromRow));
  }
  async neighbors(input: Parameters<CodeGraph["neighbors"]>[0]): Promise<GraphPage<RelationFact>> {
    if (!["CONTAINS", "IMPORTS", "CALLS", "INHERITS"].includes(input.relation) || !["incoming", "outgoing"].includes(input.direction)) throw new Error("Invalid graph relation/direction");
    if (!this.db.prepare("SELECT 1 FROM entities WHERE snapshot_id=? AND entity_id=?").get(this.snapshotId, input.symbolId)) throw new Error("Entity is not in this snapshot/generation");
    const column = input.direction === "incoming" ? "target_entity_id" : "source_entity_id";
    const sql = `${relationSelect} WHERE r.snapshot_id=? AND r.${column}=? AND r.kind=? ORDER BY r.relation_id,rs.site_id LIMIT ? OFFSET ?`;
    return this.page(input, ["neighbors", input.symbolId, input.relation, input.direction], offset => (this.db.prepare(sql).all(this.snapshotId, input.symbolId, input.relation, input.limit + 1, offset) as Record<string, unknown>[]).map(relationFromRow));
  }
}

export async function graphBuildAudit(state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core"): Promise<{ attempts: number; files: { path: string; status: string; factCount: number }[]; resolutionFiles: { path: string; siteCount: number; relationCount: number }[] }> {
  const path = graphCheckpointPath(state, snapshotId, budget, scope); const db = new DatabaseSync(path, { readOnly: true });
  try { const identity = graphIdentity(snapshotId, budget, scope); const build = db.prepare("SELECT attempts FROM graph_builds WHERE cache_identity=?").get(identity) as { attempts: number }; const rows = db.prepare("SELECT path,status,fact_count FROM file_checkpoints WHERE cache_identity=? ORDER BY path").all(identity) as unknown as { path: string; status: string; fact_count: number }[]; const resolved = db.prepare("SELECT path,site_count,relation_count FROM resolution_checkpoints WHERE cache_identity=? ORDER BY path").all(identity) as unknown as { path: string; site_count: number; relation_count: number }[]; return { attempts: Number(build.attempts), files: rows.map(row => ({ path: row.path, status: row.status, factCount: Number(row.fact_count) })), resolutionFiles: resolved.map(row => ({ path: row.path, siteCount: Number(row.site_count), relationCount: Number(row.relation_count) })) }; }
  finally { db.close(); }
}

export async function pruneUnpublishedGenerations(state: string, snapshotId: string, budget: GraphBuildBudget = DEFAULT_GRAPH_BUDGET, scope: GraphScope = "core"): Promise<void> {
  const manifest = await readPublished(state, snapshotId, budget, scope); const directory = join(graphCacheDir(state, snapshotId, budget, scope), "generations");
  let entries: string[]; try { entries = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) if (/^[a-f0-9-]+\.sqlite$/.test(entry) && entry !== `${manifest?.generationId}.sqlite`) await rm(join(directory, entry), { force: true });
}
