# ADR 0022 — Language packs and TypeScript

Status: accepted. Python refactor proven equivalent; TypeScript implemented; TypeScript review
quality not evaluated (evaluation corpora remain Python-only).
Baseline: `main` after PR #104 (ADR 0020).

## Context

Graph v4 hard-coded Python in the build orchestrator, the file scope policy, change detection,
change-unit import resolution, skill language matching and tool descriptions, and the engine imported
the Tree-sitter adapter directly. Adding a language had no seam.

## Decision

### Contracts

1. **Pure descriptor, lazy parser (D9).** `src/graph/languages/contracts.ts` defines
   `LanguageDescriptor`: id, display name, version strings, capabilities, `owns`, `classify`,
   `moduleName`, `importTarget`, `createResolver`, and the location of its extractor. Descriptors are
   pure and importable from any layer. The parser half is loaded only by `loadExtractor()`.
   Only files under `src/graph/languages/` may name `integrations/tree-sitter` (enforced by a test).
2. **Static manifest.** `src/graph/languages/index.ts` lists the registered languages in a fixed order.
   Nothing is discovered dynamically. Adding a language adds one descriptor there.
3. **Shared structure (D10).** `StructureIndexer` owns directory entities and CONTAINS for all
   languages, with the Graph v4 id formulas. `PythonResolver` keeps building them when used
   standalone (its existing API and tests); the build passes `structure: false`.
4. **Fixed vocabularies (D11).** Entity kinds, relations and resolution classes do not grow. Language
   specifics go into `ruleSource` and diagnostics. There are no cross-language edges. Optional fact
   fields were added for TypeScript only: `ExportFact`, `ReferenceFact.lookupScopeId`,
   `ImportFact.typeOnly`, `BindingFact.hoisted`.
5. **Identity (D12).** One effective language keeps the Graph v4 identity shape and strings, so a
   Python-only graph is byte-identical to before (verified on a fixture: identity directories,
   entities, relations, dependency sites, file rows, snapshot metadata and coverage). Several
   languages add their ids to the identity. *Effective* languages are the enabled ones that own a
   head path, so enabling TypeScript does not change a Python-only repository's graph.
   Deviation from the plan: the language set is recorded in `run.json` (`graphLanguages`) and in the
   graph identity, not in `configurationFingerprint`, because that fingerprint is part of the snapshot
   identity and changing it would break reruns of existing runs.
6. **Coverage (D13).** Top-level coverage fields stay totals. `coverage.byLanguage` appears only when a
   graph spans more than one language.
7. **Defaults.** Product reviews enable every registered language. Evaluations and reruns of
   historical runs stay Python-only unless they choose (`ReviewOptions.languages`). Skill language
   matching counts only the run's enabled languages, so Python-pinned runs select the same Skills
   as before.

### Seams for later languages

| Seam | Where | Contract |
|---|---|---|
| Parser | `GrammarProvider` lock + `LanguageExtractor` | Only SyntaxFacts leave the adapter; no code execution |
| Module resolution | per language (`createResolver`) | Import string → snapshot file, or external |
| Lexical binding | `LexicalBinder` (shared) | Scope walk, shadowing, hoisting via facts; never guesses |
| Capabilities | descriptor | Unsupported relations are reported, not returned empty |
| Caching | identity per effective language set | No language crosses into another's edges |
| Conformance | `tests/languages/conformance.mjs` | One rule list, one fixture per language |

Python still resolves names with its own code; migrating it onto `LexicalBinder` is a follow-up that
must pass the same equivalence check.

### TypeScript v1

- Files: `.ts .tsx .mts .cts`; `.d.ts` is not owned. JavaScript is a later dialect of this pack.
- Grammar: `tree-sitter-typescript@0.23.2` (TypeScript and TSX WASM, ABI 14) pinned by SHA-256 in
  `grammars/typescript.lock.json` and `grammars/tsx.lock.json`.
- Entities: functions, generators, `const` arrow/function values, classes and class expressions bound
  to a name, methods, accessor methods, arrow-valued fields, anonymous default exports (`default`).
  Interfaces, type aliases, enums and namespaces are not entities.
- Module resolution (D14): `ts.resolveModuleName` over a host backed only by the frozen head
  (`tsconfig.json` `baseUrl`/`paths`, extensions, index files, `.js` specifiers). `extends` and project
  references are not followed. Packages, `node_modules` and declaration files are external. Without
  the `typescript` package the build fails (graph unavailable) rather than publishing weaker edges under
  the same cache identity.
- Names: named, default, namespace and side-effect imports; `export {…}`, `export … from`,
  `export *` (bounded depth, cycles stop, several sources → candidate). Type-only imports bind no
  value and create no edge. Block and branch declarations bind conditionally (candidate). Function
  declarations and imports are hoisted; other bindings used before their definition in the same scope
  are unresolved. Anonymous callbacks get their own scope.
- Object-literal methods and named function expressions get their own scope: parameters and the
  expression's own name shadow outer functions.
- Not resolved: `obj.m()`, `this.m()` (receiver navigation candidates only), `require()`, `import()`,
  `eval`, `with`, JSX components as calls.

## Consequences

- A mixed repository builds one graph with per-language coverage. Python-only repositories and all
  Python evaluations are unaffected.
- Not measured: TypeScript review quality. A TypeScript corpus is a separate, later step.
