import type { LanguageExtractor, Relation, RelationFact, SymbolFact, SyntaxFacts } from "../contracts.ts";
import type { Declaration } from "../../engine/declarations.ts";

/**
 * Language pack contracts (ADR 0022). A descriptor is pure and dependency-free so that any layer may
 * ask "which language owns this path"; only graph builds load the parser half from integrations.
 */
export type FileClass = "production" | "test" | "example" | "benchmark" | "generated" | "vendor";

/** What a pack can produce. A relation it does not build is reported as not built, never as absent. */
export interface LanguageCapabilities { relations: readonly Relation[]; declarations: boolean; receiverNavigation: boolean }

export interface ImportTarget { module: string; files: string[]; importedName?: string }

/** Read-only view of the frozen head used to configure a resolver (for example tsconfig paths). */
export interface ResolverContext { snapshotId: string; paths: readonly string[]; readText(path: string): Promise<string> }

/** Per-language name and module resolution over SyntaxFacts. Directories and CONTAINS belong to the StructureIndexer. */
export interface LanguageResolver {
  markModuleUnavailable(moduleName: string): void;
  index(fact: SyntaxFacts): void;
  finalize(): void;
  resolveFile(fact: SyntaxFacts): RelationFact[];
  /** Entities declared in this language's files, without directories. */
  readonly languageEntities: SymbolFact[];
}

export interface DeclarationExtractor { declarations(path: string, source: string): { declarations: Declaration[]; parseComplete: boolean } }
export interface ReceiverNavigation { receiverCalls(source: string): { callerLine: number; classLine: number; member: string; line: number }[] }
export type LoadedExtractor = LanguageExtractor & Partial<DeclarationExtractor> & Partial<ReceiverNavigation> & { dispose(): void };

export interface LanguageDescriptor {
  readonly id: string;
  /** Human and tool-description name, e.g. "Python". */
  readonly displayName: string;
  readonly versions: { readonly parser: string; readonly resolver: string; readonly policy: string };
  readonly capabilities: LanguageCapabilities;
  owns(path: string): boolean;
  classify(path: string): FileClass;
  moduleName(path: string): string;
  /** Files a static import from `importerPath` names inside the snapshot, for change-aware dispatch. */
  importTarget(importerPath: string, item: { module: string; importedName?: string; relativeLevel: number }): ImportTarget;
  createResolver(context: ResolverContext): Promise<LanguageResolver>;
  /** Module (relative to src/graph/languages/) and exported class with a static async create(). */
  readonly extractor: { readonly module: string; readonly export: string };
}
