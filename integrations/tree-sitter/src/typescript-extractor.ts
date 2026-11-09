import { createHash } from "node:crypto";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { BindingFact, ExportFact, ImportFact, LanguageExtractor, ScopeFact, SourceFact, SymbolFact, SyntaxFacts } from "../../../src/graph/contracts.ts";
import type { Declaration } from "../../../src/engine/declarations.ts";
import { digest } from "../../../src/engine/declarations.ts";
import { typescriptModuleName } from "../../../src/graph/languages/typescript.ts";
import { loadPinnedGrammar } from "./pinned-grammar.ts";

const idFor = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const CLASS_DECLARATIONS = new Set(["class_declaration", "abstract_class_declaration"]);
const FUNCTION_DECLARATIONS = new Set(["function_declaration", "generator_function_declaration"]);
const BLOCKS = new Set(["statement_block", "if_statement", "else_clause", "for_statement", "for_in_statement", "while_statement", "do_statement", "try_statement", "catch_clause", "finally_clause", "switch_statement", "switch_body", "switch_case", "switch_default", "labeled_statement"]);
interface Context { scope: string; owner: SymbolFact; conditional: boolean; uncertain: boolean }

/**
 * TypeScript/TSX CST → parser-independent facts (ADR 0022). Only this adapter knows CST node types.
 * It never evaluates reviewed code. Block-scoped and branch declarations bind conditionally, so a
 * name they could shadow resolves at most to a candidate; anonymous callbacks get their own scope.
 */
export class TypeScriptTreeSitterExtractor implements LanguageExtractor {
  language = "typescript";
  private ts: Parser; private tsx: Parser;
  private constructor(ts: Parser, tsx: Parser) { this.ts = ts; this.tsx = tsx; }
  static async create(paths: { typescript?: string; tsx?: string } = {}): Promise<TypeScriptTreeSitterExtractor> {
    await Parser.init();
    const load = async (lock: "typescript" | "tsx", path?: string) => {
      const grammar = await loadPinnedGrammar(lock, path); const language = await Language.load(grammar.bytes);
      if (language.abiVersion !== grammar.abi) throw new Error(`${lock} grammar ABI does not match the checked-in lock`);
      const parser = new Parser(); parser.setLanguage(language); return parser;
    };
    return new TypeScriptTreeSitterExtractor(await load("typescript", paths.typescript), await load("tsx", paths.tsx));
  }
  private parse(path: string, source: string) {
    const tree = (path.endsWith(".tsx") ? this.tsx : this.ts).parse(source); if (!tree) throw new Error("Tree-sitter did not return a tree"); return tree;
  }

  async extract(input: { snapshotId: string; path: string; source: string }, limits: { maxFacts?: number; deadline?: number } = {}): Promise<SyntaxFacts> {
    const tree = this.parse(input.path, input.source);
    const facts: SyntaxFacts = { symbols: [], calls: [], inheritances: [], imports: [], scopes: [], bindings: [], exports: [], parseComplete: !tree.rootNode.hasError, diagnostics: [] };
    const exports = facts.exports!; let visits = 0;
    const guard = () => {
      if (++visits % 128 === 0 && limits.deadline !== undefined && performance.now() > limits.deadline) throw new Error("Graph per-file extraction time limit exceeded");
      const count = facts.symbols.length + facts.calls.length + facts.inheritances.length + facts.imports.length + facts.scopes.length + facts.bindings.length + exports.length;
      if (limits.maxFacts !== undefined && count > limits.maxFacts) throw new Error("Graph per-file extraction fact limit exceeded");
    };
    const field = (n: Node, name: string) => n.childForFieldName(name);
    const has = (n: Node, token: string) => n.children.some(child => !child.isNamed && child.type === token);
    const source = (n: Node, kind: string, qualifiedName: string, parent?: string): SourceFact => ({
      id: idFor([input.snapshotId, input.path, kind, n.startIndex, n.endIndex, qualifiedName]), snapshotId: input.snapshotId, path: input.path, qualifiedName,
      startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, startColumn: n.startPosition.column, endColumn: n.endPosition.column,
      ...(parent ? { parentSymbolId: parent } : {}),
    });
    const module: SymbolFact = { ...source(tree.rootNode, "file", typescriptModuleName(input.path)), kind: "file", name: input.path.split("/").at(-1)! };
    facts.symbols.push(module);
    const scopes = new Map<string, ScopeFact>();
    const scope = (value: ScopeFact) => { facts.scopes.push(value); scopes.set(value.id, value); return value.id; };
    scope({ id: module.id, opaque: false });
    const bind = (scopeId: string, name: string, kind: BindingFact["kind"], conditional: boolean, at: Node, targetId?: string, hoisted = false) => {
      if (!name) return;
      facts.bindings.push({ scopeId, name, kind, conditional, startLine: at.startPosition.row + 1, startColumn: at.startPosition.column, ...(targetId ? { targetId } : {}), ...(hoisted ? { hoisted } : {}) });
    };
    const text = (n: Node | null) => n?.text ?? "";
    const literal = (n: Node | null) => n ? (n.namedChildren.find(child => child.type === "string_fragment")?.text ?? n.text.replace(/^['"`]|['"`]$/g, "")) : "";
    /** Static dotted path of an expression, or [] when it is not a plain identifier chain. */
    const parts = (n: Node | null): string[] => {
      if (!n) return [];
      if (n.type === "identifier") return [n.text];
      if (n.type === "member_expression" && !n.namedChildren.some(child => child.type === "optional_chain")) {
        const property = field(n, "property"); const base = parts(field(n, "object"));
        return base.length && property?.type === "property_identifier" ? [...base, property.text] : [];
      }
      return [];
    };
    /** Every identifier a binding pattern introduces. */
    const patternNames = (n: Node | null): Node[] => !n ? [] : n.type === "identifier" || n.type === "shorthand_property_identifier_pattern" ? [n]
      : n.namedChildren.flatMap(child => child.type === "type_annotation" || (n.type === "pair_pattern" && child === field(n, "key")) ? [] : patternNames(child));
    const bindParameters = (parameters: Node | null, scopeId: string, outer: Context) => {
      for (const parameter of parameters?.namedChildren ?? []) {
        const pattern = field(parameter, "pattern") ?? (parameter.type === "identifier" ? parameter : parameter.namedChildren[0] ?? null);
        for (const name of patternNames(pattern)) bind(scopeId, name.text, "unknown", false, name);
        const value = field(parameter, "value"); if (value) walk(value, outer);
      }
    };
    const callSite = (n: Node, expression: Node | null, ctx: Context) => {
      const p = ctx.uncertain ? [] : parts(expression);
      facts.calls.push({ ...source(n, "call", `${ctx.owner.qualifiedName}@${n.startPosition.row + 1}:${n.startPosition.column}`, ctx.owner.id), kind: "call",
        expression: (expression?.text ?? "<dynamic>").slice(0, 512), parts: p, ownerSymbolId: ctx.owner.id, resolution: "unresolved", candidateTargetIds: [],
        ...(ctx.scope !== ctx.owner.id ? { lookupScopeId: ctx.scope } : {}) });
    };
    const entity = (n: Node, kind: "class" | "function", name: string, ctx: Context, functionKind?: "function" | "method") => {
      const symbol: SymbolFact = { ...source(n, kind, `${ctx.owner.qualifiedName}.${name}`, ctx.owner.id), name, kind, ...(kind === "function" ? { functionKind: functionKind ?? "function" } : {}) };
      facts.symbols.push(symbol); return symbol;
    };
    /** A function body: its own scope; class bodies are skipped for name lookup, as in Python methods. */
    const functionBody = (symbol: SymbolFact, n: Node, ctx: Context, lookupParent: string) => {
      scope({ id: symbol.id, parentId: ctx.scope, lookupParentId: lookupParent, opaque: false });
      const inner: Context = { scope: symbol.id, owner: symbol, conditional: false, uncertain: ctx.uncertain };
      bindParameters(field(n, "parameters"), symbol.id, ctx);
      const single = field(n, "parameter"); if (single?.type === "identifier") bind(symbol.id, single.text, "unknown", false, single);
      const body = field(n, "body"); if (!body) return;
      if (body.type === "statement_block") for (const child of body.namedChildren) walk(child, inner); else walk(body, inner);
    };
    const classDeclaration = (n: Node, name: string, ctx: Context, nameNode: Node) => {
      const symbol = entity(n, "class", name, ctx); bind(ctx.scope, name, "definition", ctx.conditional, nameNode, symbol.id);
      scope({ id: symbol.id, parentId: ctx.scope, lookupParentId: ctx.scope, opaque: false });
      let order = 0;
      for (const heritage of n.namedChildren.filter(child => child.type === "class_heritage")) for (const clause of heritage.namedChildren) {
        if (clause.type !== "extends_clause") continue; // implements is type-level only
        const value = field(clause, "value") ?? clause.namedChildren[0] ?? null; if (!value) continue;
        const p = ctx.uncertain ? [] : parts(value);
        facts.inheritances.push({ ...source(value, "inherit", `${symbol.qualifiedName}@base:${order}`, symbol.id), kind: "inherit", expression: value.text.slice(0, 512), parts: p,
          ownerSymbolId: symbol.id, lookupScopeId: ctx.scope, declarationOrder: order++, resolution: "unresolved", candidateTargetIds: [] });
        if (!p.length) walk(value, ctx);
      }
      const classCtx: Context = { scope: ctx.scope, owner: symbol, conditional: ctx.conditional, uncertain: ctx.uncertain };
      for (const member of field(n, "body")?.namedChildren ?? []) {
        if (member.type === "method_definition") {
          const memberName = field(member, "name"); if (!memberName || memberName.type === "computed_property_name") { if (memberName) walk(memberName, classCtx); continue; }
          functionBody(entity(member, "function", memberName.text, classCtx, "method"), member, classCtx, ctx.scope);
        } else if (member.type === "public_field_definition") {
          const value = field(member, "value"), memberName = field(member, "name");
          if (value && memberName && memberName.type !== "computed_property_name" && FUNCTION_VALUES.has(value.type)) functionBody(entity(member, "function", memberName.text, classCtx, "method"), value, classCtx, ctx.scope);
          else if (value) walk(value, classCtx);
        } else if (member.type === "class_static_block") walk(member, classCtx);
      }
    };
    const declared = (declaration: Node): string[] => {
      if (FUNCTION_DECLARATIONS.has(declaration.type) || CLASS_DECLARATIONS.has(declaration.type)) return [text(field(declaration, "name"))].filter(Boolean);
      if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") return declaration.namedChildren.filter(child => child.type === "variable_declarator").flatMap(child => patternNames(field(child, "name")).map(name => name.text));
      if (declaration.type === "enum_declaration") return [text(field(declaration, "name"))].filter(Boolean);
      return [];
    };
    const exportFact = (n: Node, exportedName: string, extra: Partial<ExportFact>) => {
      exports.push({ ...source(n, "export", `${module.qualifiedName}#${exportedName}@${n.startPosition.row + 1}:${n.startPosition.column}`, module.id), kind: "export", exportedName, ...extra });
    };
    const importFact = (n: Node, ctx: Context, specifier: string, alias: string, importedName: string | undefined, typeOnly: boolean): ImportFact => {
      const item: ImportFact = { ...source(n, "import", `${module.qualifiedName}.${alias || "<effect>"}@import:${n.startPosition.row + 1}:${n.startPosition.column}`, ctx.scope), kind: "import",
        scopeId: ctx.scope, module: specifier, ...(importedName ? { importedName } : {}), alias, boundModule: specifier, relativeLevel: 0, ...(typeOnly ? { typeOnly } : {}) };
      facts.imports.push(item); return item;
    };

    const walk = (n: Node, ctx: Context): void => {
      guard();
      if (FUNCTION_DECLARATIONS.has(n.type)) {
        const name = field(n, "name"); if (!name) return;
        const symbol = entity(n, "function", name.text, ctx); bind(ctx.scope, name.text, "definition", ctx.conditional, name, symbol.id, true);
        return functionBody(symbol, n, ctx, ctx.scope);
      }
      if (CLASS_DECLARATIONS.has(n.type)) { const name = field(n, "name"); if (name) classDeclaration(n, name.text, ctx, name); return; }
      if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
        for (const declarator of n.namedChildren.filter(child => child.type === "variable_declarator")) {
          const name = field(declarator, "name"), value = field(declarator, "value");
          if (name?.type === "identifier" && value && FUNCTION_VALUES.has(value.type)) {
            const symbol = entity(declarator, "function", name.text, ctx); bind(ctx.scope, name.text, "definition", ctx.conditional, name, symbol.id);
            functionBody(symbol, value, ctx, ctx.scope); continue;
          }
          if (name?.type === "identifier" && value?.type === "class") { classDeclaration(value, name.text, ctx, name); continue; }
          for (const binding of patternNames(name)) bind(ctx.scope, binding.text, "unknown", ctx.conditional, binding);
          if (value?.type === "call_expression" && text(field(value, "function")) === "require") facts.diagnostics.push("CommonJS require() bindings are unresolved.");
          if (value) walk(value, ctx);
        }
        return;
      }
      if (n.type === "import_statement") {
        const specifier = literal(field(n, "source")); const statementType = has(n, "type"); const clause = n.namedChildren.find(child => child.type === "import_clause");
        if (!clause) { importFact(n, ctx, specifier, "", undefined, statementType); return; }
        for (const part of clause.namedChildren) {
          if (part.type === "identifier") { const item = importFact(part, ctx, specifier, part.text, "default", statementType); if (!statementType) bind(ctx.scope, part.text, "import", ctx.conditional, part, item.id, true); }
          else if (part.type === "namespace_import") { const local = part.namedChildren.find(child => child.type === "identifier"); if (!local) continue; const item = importFact(part, ctx, specifier, local.text, undefined, statementType); if (!statementType) bind(ctx.scope, local.text, "import", ctx.conditional, local, item.id, true); }
          else if (part.type === "named_imports") for (const specifierNode of part.namedChildren.filter(child => child.type === "import_specifier")) {
            const name = field(specifierNode, "name"), alias = field(specifierNode, "alias") ?? name; if (!name || !alias) continue;
            const typeOnly = statementType || has(specifierNode, "type"); const item = importFact(specifierNode, ctx, specifier, alias.text, name.text, typeOnly);
            if (!typeOnly) bind(ctx.scope, alias.text, "import", ctx.conditional, alias, item.id, true);
          }
        }
        return;
      }
      if (n.type === "export_statement") {
        const declaration = field(n, "declaration"), from = field(n, "source"), isDefault = has(n, "default");
        if (declaration) {
          walk(declaration, ctx);
          for (const name of declared(declaration)) exportFact(n, isDefault ? "default" : name, { localName: name });
          return;
        }
        if (from) {
          const specifier = literal(from); importFact(n, ctx, specifier, "", undefined, has(n, "type"));
          const clause = n.namedChildren.find(child => child.type === "export_clause"); const namespace = n.namedChildren.find(child => child.type === "namespace_export");
          if (clause) for (const item of clause.namedChildren.filter(child => child.type === "export_specifier")) { const name = field(item, "name"), alias = field(item, "alias") ?? name; if (name && alias) exportFact(item, alias.text, { module: specifier, importedName: name.text }); }
          else exportFact(n, namespace ? text(namespace.namedChildren[0] ?? null) : "*", { module: specifier, importedName: "*" });
          return;
        }
        const clause = n.namedChildren.find(child => child.type === "export_clause");
        if (clause) { for (const item of clause.namedChildren.filter(child => child.type === "export_specifier")) { const name = field(item, "name"), alias = field(item, "alias") ?? name; if (name && alias) exportFact(item, alias.text, { localName: name.text }); } return; }
        if (isDefault) {
          const value = n.namedChildren.find(child => child.isNamed && child.type !== "comment") ?? null;
          if (value?.type === "identifier") { exportFact(n, "default", { localName: value.text }); return; }
          if (value && FUNCTION_VALUES.has(value.type)) { const symbol = entity(value, "function", "default", ctx); bind(ctx.scope, "default", "definition", ctx.conditional, value, symbol.id); functionBody(symbol, value, ctx, ctx.scope); exportFact(n, "default", { localName: "default" }); return; }
          if (value?.type === "class") { classDeclaration(value, "default", ctx, value); exportFact(n, "default", { localName: "default" }); return; }
          if (value) walk(value, ctx); return;
        }
        facts.diagnostics.push("export = / export as namespace is unresolved."); return;
      }
      if (n.type === "internal_module" || n.type === "module") { const name = field(n, "name"); if (name?.type === "identifier") bind(ctx.scope, name.text, "unknown", ctx.conditional, name); facts.diagnostics.push("TypeScript namespaces are not indexed."); return; }
      if (n.type === "enum_declaration") { const name = field(n, "name"); if (name) bind(ctx.scope, name.text, "unknown", ctx.conditional, name); return; }
      if (["interface_declaration", "type_alias_declaration", "ambient_declaration", "type_annotation", "type_arguments", "type_parameters"].includes(n.type)) return;
      if (FUNCTION_VALUES.has(n.type) || n.type === "class") {
        if (n.type === "class") { facts.diagnostics.push("Anonymous class expressions are not indexed."); return; }
        // Anonymous callback: its own lexical scope, calls stay owned by the enclosing entity.
        const id = idFor([input.snapshotId, input.path, "scope", n.startIndex, n.endIndex]);
        scope({ id, parentId: ctx.scope, lookupParentId: ctx.scope, opaque: false });
        const inner: Context = { scope: id, owner: ctx.owner, conditional: false, uncertain: ctx.uncertain };
        bindParameters(field(n, "parameters"), id, ctx);
        const single = field(n, "parameter"); if (single?.type === "identifier") bind(id, single.text, "unknown", false, single);
        const body = field(n, "body"); if (body) { if (body.type === "statement_block") for (const child of body.namedChildren) walk(child, inner); else walk(body, inner); }
        return;
      }
      if (n.type === "call_expression" || n.type === "new_expression") {
        const fn = field(n, n.type === "call_expression" ? "function" : "constructor");
        if (fn?.type === "identifier" && fn.text === "eval") { scopes.get(ctx.scope)!.opaque = true; facts.diagnostics.push("eval() makes its scope unresolved."); }
        if (fn?.type === "import" || (fn?.type === "identifier" && fn.text === "require")) { facts.diagnostics.push("Dynamic import()/require() is unresolved."); }
        else callSite(n, fn, ctx);
        if (fn && !parts(fn).length) walk(fn, ctx);
        const args = field(n, "arguments"); if (args) walk(args, ctx);
        return;
      }
      if (n.type === "for_in_statement") { for (const name of patternNames(field(n, "left"))) bind(ctx.scope, name.text, "unknown", true, name); }
      if (n.type === "catch_clause") { for (const name of patternNames(field(n, "parameter"))) bind(ctx.scope, name.text, "unknown", true, name); }
      if (n.type === "with_statement") { scopes.get(ctx.scope)!.opaque = true; facts.diagnostics.push("with makes its scope unresolved."); }
      if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") {
        const left = field(n, "left"); if (left?.type === "identifier") bind(ctx.scope, left.text, "unknown", ctx.conditional, left);
      }
      const next = BLOCKS.has(n.type) ? { ...ctx, conditional: true } : ctx;
      for (const child of n.namedChildren) walk(child, next);
    };
    try {
      const top: Context = { scope: module.id, owner: module, conditional: false, uncertain: false };
      for (const child of tree.rootNode.namedChildren) walk(child, top);
      guard();
      if (!facts.parseComplete) facts.diagnostics.push("Syntax errors exist; these facts do not cover a complete parse.");
      facts.diagnostics = [...new Set(facts.diagnostics)]; return facts;
    } finally { tree.delete(); }
  }

  /** CST-only declarations for change-aware dispatch. Source bodies become hashes, never context. */
  declarations(path: string, source: string): { declarations: Declaration[]; parseComplete: boolean } {
    const tree = this.parse(path, source); const result: Declaration[] = [];
    const field = (n: Node, k: string) => n.childForFieldName(k);
    const canonical = (n: Node): unknown => n.type === "comment" ? null : n.children.length ? [n.type, ...n.children.filter(c => c.type !== "comment").map(canonical)] : [n.type, n.text];
    const nested = new Set([...FUNCTION_DECLARATIONS, ...CLASS_DECLARATIONS, "method_definition"]);
    const own = (n: Node): unknown => nested.has(n.type) ? ["nested_declaration"] : n.type === "comment" ? null : n.children.length ? [n.type, ...n.children.filter(c => c.type !== "comment").map(own)] : [n.type, n.text];
    const range = (n: Node) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
    const push = (n: Node, scope: string, kind: "function" | "method" | "class", name: string, role: Declaration["role"], fn: Node, decorators: Node[]) => {
      const parameters = kind === "class" ? n.namedChildren.find(c => c.type === "class_heritage") ?? null : field(fn, "parameters") ?? field(fn, "parameter");
      const returns = field(fn, "return_type"); const isAsync = fn.children.some(c => c.type === "async"); const body = field(fn, "body");
      const signature = digest([isAsync, parameters ? canonical(parameters) : null, returns ? canonical(returns) : null]);
      result.push({ path, scope, kind, name, role, async: isAsync, range: range(n), definitionLine: n.startPosition.row + 1,
        identity: digest([path, scope, kind, name, role]), signature, decorators: digest(decorators.map(canonical)), body: digest(body ? own(body) : null), structure: digest(canonical(n)),
        segments: [{ part: "signature", hash: signature, range: { startLine: n.startPosition.row + 1, endLine: (parameters ?? n).endPosition.row + 1 } },
          ...decorators.map(d => ({ part: "decorator" as const, hash: digest(canonical(d)), range: range(d) })),
          ...(body?.type === "statement_block" ? body.namedChildren.filter(c => c.type !== "comment").map(c => ({ part: "body" as const, hash: digest(own(c)), range: range(c) })) : body ? [{ part: "body" as const, hash: digest(own(body)), range: range(body) }] : [])] });
      return body;
    };
    const walk = (n: Node, scope: string, inClass: boolean): void => {
      const child = (name: string) => [scope, name].filter(Boolean).join(".");
      if (FUNCTION_DECLARATIONS.has(n.type)) { const name = field(n, "name")?.text; if (!name) return; const body = push(n, scope, "function", name, "none", n, []); if (body) walk(body, child(name), false); return; }
      if (CLASS_DECLARATIONS.has(n.type)) {
        const name = field(n, "name")?.text; if (!name) return; const decorators = n.namedChildren.filter(c => c.type === "decorator");
        push(n, scope, "class", name, "none", n, decorators); for (const member of field(n, "body")?.namedChildren ?? []) walk(member, child(name), true); return;
      }
      if (n.type === "method_definition" && inClass) {
        const name = field(n, "name")?.text; if (!name) return; const role = n.children.some(c => c.type === "get") ? "getter" : n.children.some(c => c.type === "set") ? "setter" : "none";
        const body = push(n, scope, "method", name, role, n, []); if (body) walk(body, child(name + (role === "none" ? "" : ":" + role)), false); return;
      }
      if (n.type === "variable_declarator") {
        const name = field(n, "name"), value = field(n, "value");
        if (name?.type === "identifier" && value && FUNCTION_VALUES.has(value.type)) { const body = push(n, scope, inClass ? "method" : "function", name.text, "none", value, []); if (body) walk(body, child(name.text), false); return; }
      }
      if (n.type === "import_statement") {
        const module = (field(n, "source")?.namedChildren.find(c => c.type === "string_fragment")?.text) ?? ""; const typeOnly = n.children.some(c => !c.isNamed && c.type === "type");
        for (const clause of n.namedChildren.filter(c => c.type === "import_clause")) for (const part of clause.namedChildren) {
          const items: { kind: "import" | "from_import"; name: string; importedName?: string; at: Node }[] = part.type === "identifier" ? [{ kind: "from_import", name: part.text, importedName: "default", at: part }]
            : part.type === "namespace_import" ? [{ kind: "import", name: part.namedChildren[0]?.text ?? "", at: part }]
            : part.namedChildren.filter(s => s.type === "import_specifier").map(s => ({ kind: "from_import" as const, name: (field(s, "alias") ?? field(s, "name"))!.text, importedName: field(s, "name")!.text, at: s }));
          for (const item of items) {
            const importItem = { module, ...(item.importedName ? { importedName: item.importedName } : {}), localBinding: item.name, relativeLevel: 0, reexport: false, uncertain: typeOnly || scope !== "" };
            result.push({ path, scope, kind: item.kind, name: item.name, role: "none", async: false, range: range(n), definitionLine: n.startPosition.row + 1,
              identity: digest([path, scope, item.kind, item.name, "none", null]), signature: digest(importItem), decorators: digest([]), body: digest(null), structure: digest(canonical(item.at)),
              segments: [{ part: "import", hash: digest(importItem), range: range(n) }], importItem });
          }
        }
        return;
      }
      for (const c of n.namedChildren) walk(c, scope, inClass && (n.type === "class_body" || n.type === "public_field_definition"));
    };
    try { walk(tree.rootNode, "", false); return { declarations: result, parseComplete: !tree.rootNode.hasError }; } finally { tree.delete(); }
  }

  /** Local `this.member()` navigation facts inside class methods; candidates only, never CALLS. */
  receiverCalls(source: string, path = "file.ts") {
    const tree = this.parse(path, source); const result: { callerLine: number; classLine: number; member: string; line: number }[] = [];
    const field = (n: Node, k: string) => n.childForFieldName(k);
    const scan = (n: Node, method: Node, owner: Node): void => {
      if (n.type === "function_expression" || n.type === "function_declaration" || CLASS_DECLARATIONS.has(n.type) || n.type === "class") return; // these rebind `this`
      if (n.type === "call_expression") {
        const fn = field(n, "function"); const object = fn?.type === "member_expression" ? field(fn, "object") : null; const property = fn ? field(fn, "property") : null;
        if (object?.type === "this" && property?.type === "property_identifier") result.push({ callerLine: method.startPosition.row + 1, classLine: owner.startPosition.row + 1, member: property.text, line: n.startPosition.row + 1 });
      }
      for (const c of n.namedChildren) scan(c, method, owner);
    };
    const find = (n: Node): void => {
      if (CLASS_DECLARATIONS.has(n.type)) { for (const member of field(n, "body")?.namedChildren ?? []) if (member.type === "method_definition") { const body = field(member, "body"); if (body && !member.children.some(c => c.type === "static")) scan(body, member, n); } }
      for (const c of n.namedChildren) find(c);
    };
    try { if (!tree.rootNode.hasError) find(tree.rootNode); return result; } finally { tree.delete(); }
  }

  dispose(): void { this.ts.delete(); this.tsx.delete(); }
}
