/** Parser-independent serializable facts. Graph v4 indexes ONLY head. */
export type Resolution = "resolved_scoped" | "resolved_import_alias" | "candidate" | "unresolved";
export type Relation = "CONTAINS" | "IMPORTS" | "CALLS" | "INHERITS";
export type EntityKind = "directory" | "file" | "class" | "function";
export type GraphGenerationState = "ready" | "partial";
export type GraphFailureKind = "capacity" | "invalid_source" | "transient" | "cancelled" | "corrupt" | "internal";
export interface SourceFact {
  id: string; snapshotId: string; path: string; qualifiedName: string;
  startLine: number; endLine: number; startColumn: number; endColumn: number; parentSymbolId?: string;
}
export interface SymbolFact extends SourceFact { name: string; kind: EntityKind; functionKind?: "function" | "method" }
export interface ReferenceFact extends SourceFact {
  kind: "reference" | "call"; expression: string; parts: string[]; ownerSymbolId: string;
  resolution: Resolution; candidateTargetIds: string[]; ruleSource?: string;
  /** Innermost lexical scope of the site when it differs from its owner (an anonymous callback). */
  lookupScopeId?: string;
}
export interface CallSiteFact extends ReferenceFact { kind: "call" }
export interface InheritanceFact extends SourceFact {
  kind: "inherit"; expression: string; parts: string[]; ownerSymbolId: string; lookupScopeId: string;
  declarationOrder: number; resolution: Resolution; candidateTargetIds: string[];
  ruleSource?: string;
}
export interface ImportFact extends SourceFact {
  kind: "import"; scopeId: string; module: string; importedName?: string; alias: string;
  boundModule: string; relativeLevel: number;
  /** A type-only import binds no runtime value (TypeScript). */
  typeOnly?: boolean;
}
/** A module export (TypeScript). Python modules export by binding and carry none. */
export interface ExportFact extends SourceFact {
  kind: "export"; exportedName: string;
  /** Local binding exported by this module, or undefined for a re-export. */
  localName?: string;
  /** Re-export source specifier and the name taken from it ("*" for every export). */
  module?: string; importedName?: string;
}
export interface BindingFact { scopeId: string; name: string; kind: "definition" | "import" | "unknown"; targetId?: string; conditional: boolean; startLine: number; startColumn: number; hoisted?: boolean }
export interface ScopeFact { id: string; parentId?: string; lookupParentId?: string; opaque: boolean }
export interface RelationFact {
  id: string; snapshotId: string; fromId: string; toId: string; relation: Relation; resolution: Resolution;
  sourcePath: string; sourceLine: number; sourceEndLine: number; sourceColumn: number; sourceEndColumn: number;
  siteId: string; resolverVersion: string;
  siteCount?: number; declarationOrder?: number;
}
export interface GraphCoverage {
  indexedFiles: number; eligibleFiles: number; parseIncompleteFiles: number; unsupportedFiles: number;
  resolvedCalls: number; candidateCalls: number; unresolvedCalls: number;
  plannedFiles: number; failedFiles: number; omittedFiles: number;
  entityCount: number; callSiteCount: number; relationCount: number;
  totalLanguageFiles: number; changedCoreFiles: number; productionCoreFiles: number;
  omittedChangedFiles: number; omittedProductionFiles: number;
  excludedTestFiles: number; excludedExampleFiles: number; excludedBenchmarkFiles: number; excludedGeneratedFiles: number; excludedVendorFiles: number;
  referenceIndexState: "not_built";
  generationState?: GraphGenerationState; limitReason?: string;
  /** Per-language file coverage; present only when a graph spans more than one language (ADR 0022 D13). */
  byLanguage?: Record<string, { eligibleFiles: number; indexedFiles: number; parseIncompleteFiles: number; unsupportedFiles: number; failedFiles: number; omittedFiles: number }>;
}
export interface GraphPage<T> {
  status: "ok" | "partial" | "building" | "not_indexed" | "unsupported" | "parse_incomplete" | "error";
  snapshotId: string; revision?: "head"; items: T[]; truncated: boolean; nextCursor?: string;
  coverage: GraphCoverage; warnings: string[]; generationId?: string; generationState?: GraphGenerationState;
}
export interface CodeGraph {
  lookup(input: { snapshotId: string; query: string; limit: number; cursor?: string }, signal?: AbortSignal): Promise<GraphPage<SymbolFact>>;
  neighbors(input: { snapshotId: string; symbolId: string; relation: Relation; direction: "incoming" | "outgoing"; limit: number; cursor?: string }, signal?: AbortSignal): Promise<GraphPage<RelationFact>>;
}
export interface SyntaxFacts {
  symbols: SymbolFact[]; calls: CallSiteFact[]; inheritances: InheritanceFact[]; imports: ImportFact[];
  scopes: ScopeFact[]; bindings: BindingFact[]; parseComplete: boolean; diagnostics: string[];
  exports?: ExportFact[];
}
export interface LanguageExtractor {
  language: string;
  extract(input: { snapshotId: string; path: string; source: string }, limits?: { maxFacts?: number; deadline?: number }): Promise<SyntaxFacts>;
}
export const emptyCoverage = (): GraphCoverage => ({ eligibleFiles: 0, plannedFiles: 0, indexedFiles: 0, parseIncompleteFiles: 0, unsupportedFiles: 0, failedFiles: 0, omittedFiles: 0, resolvedCalls: 0, candidateCalls: 0, unresolvedCalls: 0, entityCount: 0, callSiteCount: 0, relationCount: 0, totalLanguageFiles: 0, changedCoreFiles: 0, productionCoreFiles: 0, omittedChangedFiles: 0, omittedProductionFiles: 0, excludedTestFiles: 0, excludedExampleFiles: 0, excludedBenchmarkFiles: 0, excludedGeneratedFiles: 0, excludedVendorFiles: 0, referenceIndexState: "not_built" });
