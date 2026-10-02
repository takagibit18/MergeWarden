import { sha256 } from "../infrastructure/files.ts";
import type { BindingFact, ImportFact, InheritanceFact, ReferenceFact, RelationFact, Resolution, SourceFact, SymbolFact, SyntaxFacts } from "./contracts.ts";

export const RESOLVER_VERSION = "python-entities-streaming-5";
export interface ResolvedGraph { facts: SyntaxFacts[]; entities: SymbolFact[]; relations: RelationFact[] }
type Target = { ids: string[]; resolution: Resolution; ruleSource: string };
const directoryId = (snapshotId: string, path: string) => sha256(JSON.stringify([snapshotId, "directory", path]));
const parentDirectory = (path: string) => { const index = path.lastIndexOf("/"); return index < 0 ? "/" : path.slice(0, index) || "/"; };
const unknown = (ruleSource = "unresolved_static_binding"): Target => ({ ids: [], resolution: "unresolved", ruleSource });

/**
 * Two-pass resolver state. index() retains only declarations and binding data;
 * resolveFile() can then consume and release one file's call/import/inheritance sites.
 */
export class PythonResolver {
  private readonly snapshotId: string | undefined;
  private readonly symbols = new Map<string, SymbolFact>();
  private readonly scopes = new Map<string, SyntaxFacts["scopes"][number]>();
  private readonly imports = new Map<string, ImportFact>();
  private readonly importOwners = new Map<string, SymbolFact>();
  private readonly incomplete = new Set<string>();
  private readonly bindings = new Map<string, BindingFact[]>();
  private readonly modules = new Map<string, SymbolFact[]>();
  private readonly unavailableModules = new Set<string>();
  private finished = false;

  constructor(snapshotId?: string) { this.snapshotId = snapshotId; }
  markModuleUnavailable(qualifiedName: string): void { if (this.finished) throw new Error("Python resolver index is already finalized"); this.unavailableModules.add(qualifiedName); }

  index(fact: SyntaxFacts): void {
    if (this.finished) throw new Error("Python resolver index is already finalized");
    const file = fact.symbols.find(symbol => symbol.kind === "file");
    for (const symbol of fact.symbols) {
      if (this.symbols.has(symbol.id)) throw new Error(`Duplicate graph entity id: ${symbol.id}`);
      this.symbols.set(symbol.id, symbol); if (!fact.parseComplete) this.incomplete.add(symbol.id);
    }
    for (const scope of fact.scopes) this.scopes.set(scope.id, scope);
    for (const item of fact.imports) { this.imports.set(item.id, item); if (file) this.importOwners.set(item.id, file); }
    for (const binding of fact.bindings) { const key = `${binding.scopeId}:${binding.name}`; this.bindings.set(key, [...this.bindings.get(key) ?? [], binding]); }
  }

  finalize(): void {
    if (this.finished) return;
    const id = this.snapshotId ?? this.symbols.values().next().value?.snapshotId as string | undefined;
    if (id) {
      const directories = new Set<string>(["/"]);
      for (const file of this.symbols.values()) if (file.kind === "file") {
        let current = parentDirectory(file.path); while (true) { directories.add(current); if (current === "/") break; current = parentDirectory(current); }
        file.parentSymbolId = directoryId(id, parentDirectory(file.path));
      }
      for (const path of [...directories].sort()) {
        const entity: SymbolFact = { id: directoryId(id, path), snapshotId: id, path, qualifiedName: path, name: path === "/" ? "/" : path.split("/").at(-1)!, kind: "directory", startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, ...(path === "/" ? {} : { parentSymbolId: directoryId(id, parentDirectory(path)) }) };
        this.symbols.set(entity.id, entity);
      }
    }
    for (const symbol of this.symbols.values()) if (symbol.kind === "file") this.modules.set(symbol.qualifiedName, [...this.modules.get(symbol.qualifiedName) ?? [], symbol]);
    this.finished = true;
  }

  get entities(): SymbolFact[] { this.finalize(); return [...this.symbols.values()]; }
  private moduleFor(name: string): SymbolFact[] { return this.unavailableModules.has(name) ? [] : (this.modules.get(name) ?? []).filter(module => !this.incomplete.has(module.id)); }
  private absolute(item: ImportFact, name: string): string | undefined {
    if (!item.relativeLevel) return name;
    const owner = this.importOwners.get(item.id); if (!owner) return;
    const pkg = owner.qualifiedName.split("."); if (!owner.path.endsWith("/__init__.py")) pkg.pop(); if (item.relativeLevel > pkg.length) return;
    return [...pkg.slice(0, pkg.length - item.relativeLevel + 1), ...(name ? name.split(".") : [])].join(".");
  }
  private resolveBindings(candidates: BindingFact[], seen: Set<string>): Target {
    if (!candidates.length || candidates.some(binding => binding.kind === "unknown")) return unknown("shadowed_or_reassigned");
    const targets = candidates.map(binding => binding.kind === "definition" ? { ids: binding.targetId && !this.incomplete.has(binding.targetId) ? [binding.targetId] : [], resolution: "resolved_scoped" as Resolution, ruleSource: "lexical_definition" } : this.resolveImport(this.imports.get(binding.targetId!)!, seen));
    const ids = [...new Set(targets.flatMap(target => target.ids))]; if (!ids.length) return unknown(targets[0]?.ruleSource ?? "binding_target_missing");
    const candidate = candidates.length !== 1 || candidates.some(binding => binding.conditional) || targets.some(target => target.resolution === "candidate" || !target.ids.length);
    return { ids, resolution: candidate ? "candidate" : targets[0]!.resolution, ruleSource: candidate ? "ambiguous_or_conditional_binding" : targets[0]!.ruleSource };
  }
  private member(moduleName: string, name: string, seen: Set<string>): Target {
    const owners = this.moduleFor(moduleName); if (owners.length !== 1 || this.scopes.get(owners[0]!.id)?.opaque) return unknown(this.unavailableModules.has(moduleName) ? "module_outside_published_scope" : "module_member_unavailable");
    const candidates = this.bindings.get(`${owners[0]!.id}:${name}`); if (candidates) return this.resolveBindings(candidates, seen);
    const childName = `${moduleName}.${name}`, children = this.moduleFor(childName);
    return { ids: children.map(child => child.id), resolution: children.length === 1 ? "resolved_import_alias" : children.length ? "candidate" : "unresolved", ruleSource: children.length === 1 ? "explicit_submodule" : children.length ? "ambiguous_submodule" : this.unavailableModules.has(childName) ? "module_outside_published_scope" : "module_member_missing" };
  }
  private resolveImport(item: ImportFact | undefined, seen: Set<string>): Target {
    if (!item || seen.has(item.id)) return unknown("cyclic_import_binding"); const visited = new Set(seen).add(item.id);
    const name = this.absolute(item, item.boundModule); if (name === undefined) return unknown("invalid_relative_import");
    if (item.importedName) { const result = this.member(name, item.importedName, visited); return { ...result, resolution: result.resolution === "resolved_scoped" ? "resolved_import_alias" : result.resolution, ruleSource: result.resolution === "resolved_scoped" ? "explicit_import_alias" : result.ruleSource }; }
    const found = this.moduleFor(name); return { ids: found.map(module => module.id), resolution: found.length === 1 ? "resolved_import_alias" : found.length ? "candidate" : "unresolved", ruleSource: found.length === 1 ? "explicit_module_import" : found.length ? "ambiguous_module_import" : this.unavailableModules.has(name) ? "module_outside_published_scope" : "module_not_indexed" };
  }
  private resolveParts(parts: string[], scopeStart: string, at: SourceFact): Target {
    if (!parts.length || this.incomplete.has(scopeStart)) return unknown("dynamic_expression");
    let scopeId: string | undefined = scopeStart; let found: Target = unknown();
    while (scopeId) {
      const scope = this.scopes.get(scopeId); if (!scope || scope.opaque) return unknown("opaque_scope");
      const candidates = this.bindings.get(`${scopeId}:${parts[0]}`);
      if (candidates) {
        if (scopeId === scopeStart && candidates.some(binding => binding.startLine > at.startLine || (binding.startLine === at.startLine && binding.startColumn > at.startColumn))) return unknown("binding_used_before_definition");
        found = this.resolveBindings(candidates, new Set()); break;
      }
      scopeId = scope.lookupParentId;
    }
    for (const name of parts.slice(1)) {
      if (found.ids.length !== 1 || found.resolution !== "resolved_import_alias") return unknown("dynamic_receiver");
      const owner = this.symbols.get(found.ids[0]!); if (owner?.kind !== "file") return unknown("dynamic_receiver");
      const result = this.member(owner.qualifiedName, name, new Set()); found = { ...result, resolution: result.resolution === "resolved_scoped" ? "resolved_import_alias" : result.resolution, ruleSource: result.resolution === "resolved_scoped" ? "explicit_module_member" : result.ruleSource };
    }
    return found;
  }
  private relation(fromId: string, toId: string, relation: RelationFact["relation"], at: SourceFact, resolution: Resolution, declarationOrder?: number): RelationFact {
    return { id: sha256(JSON.stringify([at.snapshotId, fromId, toId, relation, at.id, RESOLVER_VERSION])), snapshotId: at.snapshotId, fromId, toId, relation, resolution,
      sourcePath: at.path, sourceLine: at.startLine, sourceEndLine: at.endLine, sourceColumn: at.startColumn, sourceEndColumn: at.endColumn,
      siteId: at.id, resolverVersion: RESOLVER_VERSION, ...(declarationOrder === undefined ? {} : { declarationOrder }) };
  }

  structuralRelations(): RelationFact[] {
    return this.entities.filter(entity => entity.parentSymbolId).map(entity => this.relation(entity.parentSymbolId!, entity.id, "CONTAINS", entity, "resolved_scoped"));
  }

  resolveFile(fact: SyntaxFacts): RelationFact[] {
    this.finalize(); const relations: RelationFact[] = [];
    const resolveSite = (site: ReferenceFact | InheritanceFact): Target => this.resolveParts(site.parts, "lookupScopeId" in site ? site.lookupScopeId : site.ownerSymbolId, site);
    for (const item of fact.imports) {
      if (!fact.parseComplete || this.scopes.get(item.scopeId)?.opaque && item.alias !== "*") continue;
      const importedModules = this.moduleFor(this.absolute(item, item.module) ?? "");
      const importName = this.absolute(item, item.module) ?? "";
      const result: Target = item.importedName ? this.resolveImport(item, new Set()) : { ids: importedModules.map(module => module.id), resolution: importedModules.length === 1 ? "resolved_import_alias" : importedModules.length ? "candidate" : "unresolved", ruleSource: importedModules.length === 1 ? "explicit_module_import" : importedModules.length ? "ambiguous_module_import" : this.unavailableModules.has(importName) ? "module_outside_published_scope" : "module_not_indexed" };
      const conditional = (this.bindings.get(`${item.scopeId}:${item.alias}`) ?? []).some(binding => binding.targetId === item.id && binding.conditional);
      for (const targetId of result.ids) relations.push(this.relation(item.scopeId, targetId, "IMPORTS", item, conditional ? "candidate" : result.resolution));
    }
    for (const site of fact.calls) {
      let result = fact.parseComplete ? resolveSite(site) : unknown("parse_incomplete");
      if (result.ids.some(targetId => this.symbols.get(targetId)?.kind === "file")) result = unknown("module_not_callable");
      site.resolution = result.resolution; site.candidateTargetIds = result.ids; site.ruleSource = result.ruleSource;
      if (result.resolution !== "candidate") for (const targetId of result.ids) if (["function", "class"].includes(this.symbols.get(targetId)!.kind)) relations.push(this.relation(site.ownerSymbolId, targetId, "CALLS", site, result.resolution));
    }
    for (const site of fact.inheritances) {
      const result = fact.parseComplete ? resolveSite(site) : unknown("parse_incomplete");
      site.resolution = result.resolution; site.candidateTargetIds = result.ids; site.ruleSource = result.ruleSource;
      if (result.resolution !== "candidate") for (const targetId of result.ids) if (this.symbols.get(targetId)?.kind === "class") relations.push(this.relation(site.ownerSymbolId, targetId, "INHERITS", site, result.resolution, site.declarationOrder));
    }
    return relations.sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** Convenience adapter for unit-sized inputs. Production builds use PythonResolver in two streaming passes. */
export function resolvePython(input: SyntaxFacts[], options: { snapshotId?: string; maxRelations?: number } = {}): ResolvedGraph {
  const resolver = new PythonResolver(options.snapshotId ?? input[0]?.symbols[0]?.snapshotId);
  for (const fact of input) resolver.index(fact); resolver.finalize();
  const relations = resolver.structuralRelations();
  if (relations.length > (options.maxRelations ?? Number.MAX_SAFE_INTEGER)) throw new Error("Graph relation limit exceeded");
  for (const fact of input) {
    relations.push(...resolver.resolveFile(fact));
    if (relations.length > (options.maxRelations ?? Number.MAX_SAFE_INTEGER)) throw new Error("Graph relation limit exceeded");
  }
  return { facts: input, entities: resolver.entities, relations: relations.sort((a, b) => a.id.localeCompare(b.id)) };
}
