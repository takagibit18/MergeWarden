import { sha256 } from "../infrastructure/files.ts";
import type { BindingFact, ExportFact, ImportFact, InheritanceFact, ReferenceFact, RelationFact, Resolution, SourceFact, SymbolFact, SyntaxFacts } from "./contracts.ts";
import type { LanguageResolver } from "./languages/contracts.ts";
import { LexicalBinder, unresolved } from "./lexical-binder.ts";
import type { Target } from "./lexical-binder.ts";

export const TYPESCRIPT_RESOLVER_VERSION = "typescript-entities-1";
/** Resolve an import specifier from a file to a head path, or undefined for external/unknown modules. */
export type SpecifierResolver = (specifier: string, fromPath: string) => string | undefined;
const MAX_EXPORT_DEPTH = 8;

/**
 * TypeScript name and module resolution over parser-independent facts (ADR 0022). Lexical lookup is
 * the shared LexicalBinder; this class only follows imports and exports. Module paths come from an
 * injected specifier resolver (TypeScript's own module resolution over the frozen head). No receiver
 * typing: `obj.m()` and `this.m()` stay unresolved; no cross-language edges; no same-name fallback.
 */
export class TypeScriptResolver implements LanguageResolver {
  private readonly snapshotId: string; private readonly resolveSpecifier: SpecifierResolver; private readonly moduleName: (path: string) => string;
  private readonly binder = new LexicalBinder();
  private readonly symbols = new Map<string, SymbolFact>();
  private readonly files = new Map<string, SymbolFact>();
  private readonly imports = new Map<string, ImportFact>();
  private readonly exports = new Map<string, ExportFact[]>();
  private readonly incomplete = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly specifiers = new Map<string, string | undefined>();
  private finished = false;

  constructor(snapshotId: string, resolveSpecifier: SpecifierResolver, moduleName: (path: string) => string) { this.snapshotId = snapshotId; this.resolveSpecifier = resolveSpecifier; this.moduleName = moduleName; }
  markModuleUnavailable(moduleName: string): void { if (this.finished) throw new Error("TypeScript resolver index is already finalized"); this.unavailable.add(moduleName); }

  index(fact: SyntaxFacts): void {
    if (this.finished) throw new Error("TypeScript resolver index is already finalized");
    const file = fact.symbols.find(symbol => symbol.kind === "file"); if (!file) throw new Error("TypeScript facts have no file entity");
    for (const symbol of fact.symbols) {
      if (this.symbols.has(symbol.id)) throw new Error(`Duplicate graph entity id: ${symbol.id}`);
      this.symbols.set(symbol.id, symbol); if (!fact.parseComplete) this.incomplete.add(symbol.id);
    }
    this.files.set(file.path, file); this.binder.index(fact);
    for (const item of fact.imports) this.imports.set(item.id, item);
    this.exports.set(file.path, [...fact.exports ?? []]);
  }
  finalize(): void { this.finished = true; }
  get languageEntities(): SymbolFact[] { return [...this.symbols.values()]; }

  private relation(fromId: string, toId: string, relation: RelationFact["relation"], at: SourceFact, resolution: Resolution, declarationOrder?: number): RelationFact {
    return { id: sha256(JSON.stringify([at.snapshotId, fromId, toId, relation, at.id, TYPESCRIPT_RESOLVER_VERSION])), snapshotId: at.snapshotId, fromId, toId, relation, resolution,
      sourcePath: at.path, sourceLine: at.startLine, sourceEndLine: at.endLine, sourceColumn: at.startColumn, sourceEndColumn: at.endColumn,
      siteId: at.id, resolverVersion: TYPESCRIPT_RESOLVER_VERSION, ...(declarationOrder === undefined ? {} : { declarationOrder }) };
  }

  /** The indexed, parse-complete file a specifier names, or the reason it cannot be used. */
  private module(specifier: string, fromPath: string): SymbolFact | string {
    const key = `${fromPath}\0${specifier}`;
    if (!this.specifiers.has(key)) { let path: string | undefined; try { path = this.resolveSpecifier(specifier, fromPath); } catch { path = undefined; } this.specifiers.set(key, path); }
    const path = this.specifiers.get(key); if (!path) return "module_external_or_unknown";
    if (this.unavailable.has(this.moduleName(path))) return "module_outside_published_scope";
    const file = this.files.get(path); if (!file) return "module_not_indexed";
    return this.incomplete.has(file.id) ? "module_parse_incomplete" : file;
  }

  /** What a module exports under a name: a local binding, a re-export, or one of its `export *` sources. */
  private exported(file: SymbolFact, name: string, seen: Set<string>): Target {
    const key = `${file.path}#${name}`; if (seen.has(key) || seen.size > MAX_EXPORT_DEPTH * 4) return unresolved("cyclic_or_deep_export"); const visited = new Set(seen).add(key);
    const scope = this.binder.scope(file.id); if (!scope || scope.opaque) return unresolved("opaque_scope");
    const direct = (this.exports.get(file.path) ?? []).filter(item => item.exportedName === name);
    if (direct.length) {
      const targets = direct.map(item => this.followExport(file, item, visited)); const ids = [...new Set(targets.flatMap(target => target.ids))];
      if (!ids.length) return unresolved(targets[0]?.ruleSource ?? "export_target_missing");
      const candidate = direct.length !== 1 || targets[0]!.resolution === "candidate";
      return { ids, resolution: candidate ? "candidate" : "resolved_import_alias", ruleSource: candidate ? "ambiguous_export" : targets[0]!.ruleSource };
    }
    if (name === "default") return unresolved("default_export_missing");
    const stars = (this.exports.get(file.path) ?? []).filter(item => item.exportedName === "*" && item.module);
    const found = stars.map(item => { const source = this.module(item.module!, file.path); return typeof source === "string" ? unresolved(source) : this.exported(source, name, visited); }).filter(target => target.ids.length);
    if (!found.length) return unresolved(stars.length ? "star_export_member_missing" : "module_member_missing");
    const ids = [...new Set(found.flatMap(target => target.ids))];
    return ids.length === 1 && found.every(target => target.resolution !== "candidate") ? { ids, resolution: "resolved_import_alias", ruleSource: "star_reexport" } : { ids, resolution: "candidate", ruleSource: "ambiguous_star_reexport" };
  }

  private followExport(file: SymbolFact, item: ExportFact, seen: Set<string>): Target {
    if (item.localName !== undefined) {
      const bindings = this.binder.bindingsIn(file.id, item.localName); if (!bindings) return unresolved("exported_binding_missing");
      return this.binder.combine(bindings, binding => this.follow(binding, seen));
    }
    const source = this.module(item.module ?? "", file.path); if (typeof source === "string") return unresolved(source);
    if (item.importedName === "*") return { ids: [source.id], resolution: "resolved_import_alias", ruleSource: "namespace_reexport" };
    const target = this.exported(source, item.importedName ?? item.exportedName, seen);
    return target.ids.length ? { ...target, ruleSource: target.resolution === "candidate" ? target.ruleSource : "explicit_reexport" } : target;
  }

  /** Follow one binding: a local definition, or an import through its module's exports. */
  private follow(binding: BindingFact, seen = new Set<string>()): Target {
    if (binding.kind === "definition") return binding.targetId && !this.incomplete.has(binding.targetId) ? { ids: [binding.targetId], resolution: "resolved_scoped", ruleSource: "lexical_definition" } : unresolved("binding_target_missing");
    const item = binding.targetId ? this.imports.get(binding.targetId) : undefined; if (!item || item.typeOnly) return unresolved("type_only_or_missing_import");
    const importer = this.symbols.get(item.scopeId)?.path ?? item.path;
    const source = this.module(item.module, importer); if (typeof source === "string") return unresolved(source);
    if (item.importedName === undefined) return { ids: [source.id], resolution: "resolved_import_alias", ruleSource: "namespace_import" };
    const target = this.exported(source, item.importedName, seen);
    return target.ids.length && target.resolution !== "candidate" ? { ...target, resolution: "resolved_import_alias", ruleSource: "explicit_import_alias" } : target;
  }

  private resolveParts(parts: string[], scopeStart: string, at: SourceFact): Target {
    if (!parts.length) return unresolved("dynamic_expression");
    let found = this.binder.lookup(parts[0]!, scopeStart, at, binding => this.follow(binding));
    for (const name of parts.slice(1)) {
      // Only a namespace import is a static receiver: `ns.member()`.
      if (found.ids.length !== 1 || found.resolution !== "resolved_import_alias") return unresolved("dynamic_receiver");
      const owner = this.symbols.get(found.ids[0]!); if (owner?.kind !== "file") return unresolved("dynamic_receiver");
      const member = this.exported(owner, name, new Set()); found = member.ids.length && member.resolution !== "candidate" ? { ...member, resolution: "resolved_import_alias", ruleSource: "namespace_member" } : member;
    }
    return found;
  }

  resolveFile(fact: SyntaxFacts): RelationFact[] {
    this.finalize(); const relations: RelationFact[] = [];
    for (const item of fact.imports) {
      if (!fact.parseComplete || item.typeOnly) continue; // erased at runtime
      const importer = this.symbols.get(item.scopeId)?.path ?? item.path; const source = this.module(item.module, importer);
      if (typeof source === "string") continue;
      let result: Target = { ids: [source.id], resolution: "resolved_import_alias", ruleSource: "explicit_module_import" };
      if (item.importedName !== undefined) { const member = this.exported(source, item.importedName, new Set()); if (member.ids.length) result = member; }
      const conditional = (this.binder.bindingsIn(item.scopeId, item.alias) ?? []).some(binding => binding.targetId === item.id && binding.conditional);
      for (const targetId of result.ids) relations.push(this.relation(item.scopeId, targetId, "IMPORTS", item, conditional ? "candidate" : result.resolution));
    }
    const resolveSite = (site: ReferenceFact | InheritanceFact) => this.resolveParts(site.parts, "lookupScopeId" in site && site.lookupScopeId ? site.lookupScopeId : site.ownerSymbolId, site);
    for (const site of fact.calls) {
      let result = fact.parseComplete ? resolveSite(site) : unresolved("parse_incomplete");
      if (result.ids.some(targetId => this.symbols.get(targetId)?.kind === "file")) result = unresolved("module_not_callable");
      site.resolution = result.resolution; site.candidateTargetIds = result.ids; site.ruleSource = result.ruleSource;
      if (result.resolution !== "candidate") for (const targetId of result.ids) if (["function", "class"].includes(this.symbols.get(targetId)?.kind ?? "")) relations.push(this.relation(site.ownerSymbolId, targetId, "CALLS", site, result.resolution));
    }
    for (const site of fact.inheritances) {
      const result = fact.parseComplete ? resolveSite(site) : unresolved("parse_incomplete");
      site.resolution = result.resolution; site.candidateTargetIds = result.ids; site.ruleSource = result.ruleSource;
      if (result.resolution !== "candidate") for (const targetId of result.ids) if (this.symbols.get(targetId)?.kind === "class") relations.push(this.relation(site.ownerSymbolId, targetId, "INHERITS", site, result.resolution, site.declarationOrder));
    }
    return relations.sort((a, b) => a.id.localeCompare(b.id));
  }
}
