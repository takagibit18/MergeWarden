import { sha256 } from "../infrastructure/files.ts";
import type { RelationFact, SymbolFact } from "./contracts.ts";

/**
 * Language-neutral repository structure (ADR 0022 D10): directory entities and CONTAINS edges.
 * Every language's files share one directory tree. The id formulas are the ones Graph v4 has always
 * used, so a single-language build is byte-identical to the former resolver-owned structure.
 */
export const directoryId = (snapshotId: string, path: string) => sha256(JSON.stringify([snapshotId, "directory", path]));
export const parentDirectory = (path: string) => { const index = path.lastIndexOf("/"); return index < 0 ? "/" : path.slice(0, index) || "/"; };

/** Assign each file entity its parent directory and return the sorted directory entities. Mutates file facts. */
export function attachDirectories(snapshotId: string, entities: Iterable<SymbolFact>): SymbolFact[] {
  const directories = new Set<string>(["/"]);
  for (const file of entities) if (file.kind === "file") {
    let current = parentDirectory(file.path); while (true) { directories.add(current); if (current === "/") break; current = parentDirectory(current); }
    file.parentSymbolId = directoryId(snapshotId, parentDirectory(file.path));
  }
  return [...directories].sort().map(path => ({ id: directoryId(snapshotId, path), snapshotId, path, qualifiedName: path, name: path === "/" ? "/" : path.split("/").at(-1)!,
    kind: "directory" as const, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, ...(path === "/" ? {} : { parentSymbolId: directoryId(snapshotId, parentDirectory(path)) }) }));
}

/** CONTAINS from every entity's parent. `version` is part of the relation identity. */
export function containsRelations(entities: readonly SymbolFact[], version: string): RelationFact[] {
  return entities.filter(entity => entity.parentSymbolId).map(at => ({
    id: sha256(JSON.stringify([at.snapshotId, at.parentSymbolId!, at.id, "CONTAINS", at.id, version])), snapshotId: at.snapshotId, fromId: at.parentSymbolId!, toId: at.id,
    relation: "CONTAINS" as const, resolution: "resolved_scoped" as const, sourcePath: at.path, sourceLine: at.startLine, sourceEndLine: at.endLine,
    sourceColumn: at.startColumn, sourceEndColumn: at.endColumn, siteId: at.id, resolverVersion: version }));
}

/**
 * Structure over all languages of one build. With one language the relation version is that
 * language's resolver version (Graph v4 compatibility); with several it is a combined label.
 */
export class StructureIndexer {
  readonly version: string; private readonly snapshotId: string;
  constructor(snapshotId: string, resolverVersions: readonly string[]) {
    this.snapshotId = snapshotId; this.version = resolverVersions.length === 1 ? resolverVersions[0]! : `structure-1(${[...resolverVersions].join("+")})`;
  }
  /** Copies language entities, attaches file parents and appends directories, in a stable order. */
  entities(languageEntities: readonly SymbolFact[]): SymbolFact[] {
    const copies = languageEntities.map(entity => ({ ...entity }));
    return [...copies, ...attachDirectories(this.snapshotId, copies)];
  }
  relations(entities: readonly SymbolFact[]): RelationFact[] { return containsRelations(entities, this.version); }
}
