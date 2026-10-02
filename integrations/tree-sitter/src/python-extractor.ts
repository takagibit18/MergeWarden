import { createHash } from "node:crypto";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { LanguageExtractor, SyntaxFacts, SymbolFact, SourceFact, ScopeFact } from "../../../src/graph/contracts.ts";
import { pythonModuleName } from "../../../src/graph/scope-policy.ts";
import { loadPinnedPythonGrammar } from "./pinned-grammar.ts";
import { declarations, receiverCalls } from './declarations.ts';
const idFor = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const pythonModule = pythonModuleName;
/** Only this adapter knows CST node types. No tree/node escapes extract(). */
export class PythonTreeSitterExtractor implements LanguageExtractor {
  language = "python";
  declarations(path: string, source: string) { return declarations(this.parser, path, source); }
  receiverCalls(source:string) {return receiverCalls(this.parser,source);}
  private parser: Parser;
  private constructor(parser: Parser) { this.parser = parser; }
  static async create(vettedGrammarWasmPath?: string): Promise<PythonTreeSitterExtractor> {
    const grammar = await loadPinnedPythonGrammar(vettedGrammarWasmPath);
    await Parser.init(); const language = await Language.load(grammar.bytes);
    if (language.abiVersion !== grammar.abi) throw new Error("Python grammar ABI does not match the checked-in lock");
    const parser = new Parser(); parser.setLanguage(language); return new PythonTreeSitterExtractor(parser);
  }
  async extract(input: { snapshotId: string; path: string; source: string }, limits: { maxFacts?: number; deadline?: number } = {}): Promise<SyntaxFacts> {
    const tree = this.parser.parse(input.source); if (!tree) throw new Error("Tree-sitter did not return a tree");
    const facts: SyntaxFacts = { symbols: [], calls: [], inheritances: [], imports: [], scopes: [], bindings: [], parseComplete: !tree.rootNode.hasError, diagnostics: [] };
    let visits = 0;
    const guard = () => {
      if (++visits % 128 === 0 && limits.deadline !== undefined && performance.now() > limits.deadline) throw new Error("Graph per-file extraction time limit exceeded");
      const count = facts.symbols.length + facts.calls.length + facts.inheritances.length + facts.imports.length + facts.scopes.length + facts.bindings.length;
      if (limits.maxFacts !== undefined && count > limits.maxFacts) throw new Error("Graph per-file extraction fact limit exceeded");
    };
    const field = (n: Node, name: string) => n.childForFieldName(name);
    const source = (n: Node, kind: string, qualifiedName: string, parent?: string): SourceFact => ({
      id: idFor([input.snapshotId, input.path, kind, n.startIndex, n.endIndex, qualifiedName]), snapshotId: input.snapshotId, path: input.path, qualifiedName,
      startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, startColumn: n.startPosition.column, endColumn: n.endPosition.column,
      ...(parent ? { parentSymbolId: parent } : {}),
    });
    const module: SymbolFact = { ...source(tree.rootNode, "file", pythonModule(input.path)), kind: "file", name: input.path.split("/").at(-1)! };
    facts.symbols.push(module); facts.scopes.push({ id: module.id, opaque: false });
    const scopes = new Map<string, ScopeFact>([[module.id, facts.scopes[0]!]]);
    const symbols = new Map<string, SymbolFact>([[module.id, module]]);
    const bind = (scope: SymbolFact, name: string, kind: "definition" | "import" | "unknown", conditional: boolean, targetId?: string, at?: Node) => {
      facts.bindings.push({ scopeId: scope.id, name, kind, conditional, startLine: at ? at.startPosition.row + 1 : scope.startLine, startColumn: at?.startPosition.column ?? scope.startColumn, ...(targetId ? { targetId } : {}) });
    };
    const parts = (n: Node | null): string[] => !n ? [] : n.type === "identifier" ? [n.text] : n.type === "attribute" ? (() => { const base = parts(field(n, "object")); const attr = field(n, "attribute"); return base.length && attr ? [...base, attr.text] : []; })() : [];
    const target = (n: Node | null, scope: SymbolFact) => {
      if (!n) return;
      if (n.type === "identifier") bind(scope, n.text, "unknown", false);
      else if (["attribute", "subscript"].includes(n.type)) {
        // Receiver mutation may replace a callable. Record uncertainty instead of following its former import binding.
        const root = parts(n.type === "attribute" ? field(n, "object") : field(n, "value"))[0];
        if (root) bind(scope, root, "unknown", false);
      } else for (const c of n.namedChildren) target(c, scope);
    };
    const callSite = (n: Node, expression: Node | null, scope: SymbolFact, uncertain: boolean) => {
      const p = uncertain ? [] : parts(expression); const expr = (expression?.text ?? "<dynamic>").slice(0, 512);
      facts.calls.push({ ...source(n, "call", `${scope.qualifiedName}@${n.startPosition.row + 1}:${n.startPosition.column}`, scope.id), expression: expr, parts: p, ownerSymbolId: scope.id, resolution: "unresolved", candidateTargetIds: [], kind: "call" });
    };
    const inheritanceSite = (n: Node, owner: SymbolFact, lookupScope: SymbolFact, declarationOrder: number, uncertain: boolean) => {
      const p = uncertain ? [] : parts(n);
      facts.inheritances.push({ ...source(n, "inherit", `${owner.qualifiedName}@base:${declarationOrder}`, owner.id), kind: "inherit", expression: n.text.slice(0, 512), parts: p, ownerSymbolId: owner.id, lookupScopeId: lookupScope.id, declarationOrder, resolution: "unresolved", candidateTargetIds: [] });
    };
    const walk = (n: Node, scope: SymbolFact, conditional = false, uncertain = false): void => {
      guard();
      if (n.type === "function_definition" || n.type === "class_definition") {
        const name = field(n, "name"); if (!name) return;
        const kind = n.type === "class_definition" ? "class" : "function";
        const symbol: SymbolFact = { ...source(n, kind, `${scope.qualifiedName}.${name.text}`, scope.id), name: name.text, kind, ...(kind === "function" ? { functionKind: scope.kind === "class" ? "method" as const : "function" as const } : {}) };
        facts.symbols.push(symbol); symbols.set(symbol.id, symbol);
        const metaclass = field(n, "superclasses")?.namedChildren.some(c => c.type === "keyword_argument" && field(c, "name")?.text === "metaclass");
        bind(scope, name.text, metaclass ? "unknown" : "definition", conditional || n.parent?.type === "decorated_definition", symbol.id, n);
        if (metaclass) facts.diagnostics.push("Explicit metaclass construction is unresolved.");
        let lookup: SymbolFact | undefined = scope;
        while (lookup?.kind === "class") lookup = symbols.get(scopes.get(lookup.id)?.lookupParentId ?? "");
        const sc: ScopeFact = { id: symbol.id, parentId: scope.id, ...(lookup ? { lookupParentId: lookup.id } : {}), opaque: false };
        facts.scopes.push(sc); scopes.set(sc.id, sc);
        const parameters = field(n, "parameters");
        if (parameters) for (const p of parameters.namedChildren) {
          const parameter = field(p, "name") ?? (p.type === "identifier" ? p : p.namedChildren[0]);
          if (parameter) target(parameter, symbol);
          const value = field(p, "value"); if (value) walk(value, scope, conditional, uncertain);
          const annotation = field(p, "type"); if (annotation) walk(annotation, scope, conditional, true);
        }
        const bases = field(n, "superclasses");
        if (n.type === "class_definition" && bases) {
          let declarationOrder = 0;
          for (const base of bases.namedChildren) {
            if (base.type === "keyword_argument") continue;
            inheritanceSite(base, symbol, scope, declarationOrder++, uncertain);
            walk(base, scope, conditional, uncertain || !parts(base).length);
          }
        }
        const annotation = field(n, "return_type"); if (annotation) walk(annotation, scope, conditional, true);
        if (field(n, "type_parameters")) sc.opaque = true;
        const body = field(n, "body"); if (body) walk(body, symbol, false, uncertain);
        return;
      }
      if (n.type === "import_statement" || n.type === "import_from_statement") {
        const mod = field(n, "module_name"); const raw = mod?.text ?? "";
        const relativeLevel = raw.length - raw.replace(/^\.+/, "").length; const moduleName = raw.slice(relativeLevel);
        const wildcard = n.namedChildren.find(c => c.type === "wildcard_import");
        if (wildcard) {
          scopes.get(scope.id)!.opaque = true; facts.diagnostics.push("Wildcard import preserves only module structure; imported names remain unresolved.");
          facts.imports.push({ ...source(wildcard, "import", `${scope.qualifiedName}.*@import`, scope.id), kind: "import", scopeId: scope.id, module: moduleName, alias: "*", boundModule: moduleName, relativeLevel });
        }
        for (const c of n.namedChildren.filter(c => c.id !== mod?.id && ["dotted_name", "aliased_import"].includes(c.type))) {
          const name = (field(c, "name") ?? c).text; const alias = field(c, "alias")?.text;
          const imported = n.type === "import_from_statement"; const bound = alias ?? (imported ? name : name.split(".")[0]!);
          const imp = { ...source(c, "import", `${scope.qualifiedName}.${bound}@import`, scope.id), kind: "import" as const, scopeId: scope.id,
            module: imported ? moduleName : name, ...(imported ? { importedName: name } : {}), alias: bound,
            boundModule: imported ? moduleName : alias ? name : name.split(".")[0]!, relativeLevel };
          facts.imports.push(imp); bind(scope, bound, "import", conditional, imp.id, c);
        }
        return;
      }
      if (["global_statement", "nonlocal_statement"].includes(n.type)) {
        facts.diagnostics.push("global/nonlocal rebinding is unresolved in its containing scope."); scopes.get(scope.id)!.opaque = true; return;
      }
      if (["lambda", "list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"].includes(n.type)) {
        const unknown = (node: Node) => { if (node.type === "call") callSite(node, field(node, "function"), scope, true); if (node.type === "named_expression") target(field(node, "name"), scope); for (const c of node.namedChildren) unknown(c); };
        unknown(n); facts.diagnostics.push("Lambda/comprehension scope is unresolved."); return;
      }
      if (["assignment", "augmented_assignment", "named_expression"].includes(n.type)) {
        const left = field(n, "left") ?? field(n, "name"); target(left, scope);
        for (const c of n.namedChildren) if (c.id !== left?.id) walk(c, scope, conditional, uncertain || c.id === field(n, "type")?.id);
        return;
      }
      if (["for_statement", "for_in_clause"].includes(n.type)) target(field(n, "left"), scope);
      if (n.type === "as_pattern") target(field(n, "alias"), scope);
      if (n.type === "delete_statement") for (const c of n.namedChildren) target(c, scope);
      if (["match_statement", "type_alias_statement"].includes(n.type)) { scopes.get(scope.id)!.opaque = true; uncertain = true; facts.diagnostics.push("Pattern/type alias binding is unresolved."); }
      if (n.type === "call") {
        const fn = field(n, "function"); callSite(n, fn, scope, uncertain);
        if (fn?.type === "identifier" && ["exec", "eval"].includes(fn.text)) scopes.get(scope.id)!.opaque = true;
        if (fn && !parts(fn).length) walk(fn, scope, conditional, uncertain);
        const argumentsNode = field(n, "arguments"); if (argumentsNode) walk(argumentsNode, scope, conditional, uncertain);
        return;
      }
      if (n.type === "keyword_argument") { const value = field(n, "value"); if (value) walk(value, scope, conditional, uncertain); return; }
      // Ordinary reads and attribute access remain analysis input only; they are not core graph sites.
      if (n.type === "attribute" || n.type === "identifier") { if (n.type === "attribute" && !parts(n).length) { const receiver = field(n, "object"); if (receiver) walk(receiver, scope, conditional, uncertain); } return; }
      const branch = conditional || ["if_statement", "try_statement", "for_statement", "while_statement", "with_statement"].includes(n.type);
      for (const c of n.namedChildren) walk(c, scope, branch, uncertain);
    };
    try {
      for (const child of tree.rootNode.namedChildren) walk(child, module);
      guard();
      if (!facts.parseComplete) facts.diagnostics.push("Syntax errors exist; these facts do not cover a complete parse.");
      facts.diagnostics = [...new Set(facts.diagnostics)]; return facts;
    } finally { tree.delete(); }
  }
  dispose(): void { this.parser.delete(); }
}
