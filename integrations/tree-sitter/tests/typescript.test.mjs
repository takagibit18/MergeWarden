import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeScriptTreeSitterExtractor } from "../src/typescript-extractor.ts";
import { createSpecifierResolver } from "../src/typescript-modules.ts";
import { matchDeclarations } from "../../../src/engine/declarations.ts";

const extractor = await TypeScriptTreeSitterExtractor.create();
test.after(() => extractor.dispose());
const extract = (source, path = "src/app.ts") => extractor.extract({ snapshotId: "s", path, source });

test("entities cover declarations, arrow consts, methods, fields and default exports with module-qualified names", async () => {
  const facts = await extract(`export function a() {}\nexport const b = async (x: number) => x;\nclass C extends D { m() {} get v() { return 1 } f = () => 1; static s() {} }\nexport default function () {}\ninterface I { x: number }\ntype T = string;\nconst n = 1;\n`);
  assert.equal(facts.parseComplete, true);
  assert.deepEqual(facts.symbols.map(s => [s.kind, s.qualifiedName, s.functionKind ?? null]), [
    ["file", "src/app", null], ["function", "src/app.a", "function"], ["function", "src/app.b", "function"], ["class", "src/app.C", null],
    ["function", "src/app.C.m", "method"], ["function", "src/app.C.v", "method"], ["function", "src/app.C.f", "method"], ["function", "src/app.C.s", "method"], ["function", "src/app.default", "function"],
  ]);
  assert.deepEqual(facts.exports.map(e => [e.exportedName, e.localName ?? null]), [["a", "a"], ["b", "b"], ["default", "default"]]);
  assert.deepEqual(facts.inheritances.map(i => i.parts), [["D"]]);
  assert.ok(!facts.symbols.some(s => s.name === "I" || s.name === "T"), "type-level declarations are not runtime entities");
});

test("imports distinguish default, named, namespace, side-effect and type-only; re-exports become export facts", async () => {
  const facts = await extract(`import d, { a as b, type T } from './x';\nimport * as ns from '../y.js';\nimport type { U } from './u';\nimport './effect';\nexport { z as zz } from './z';\nexport * from './all';\nexport { local as renamed };\n`);
  assert.deepEqual(facts.imports.map(i => [i.module, i.importedName ?? null, i.alias, !!i.typeOnly]), [
    ["./x", "default", "d", false], ["./x", "a", "b", false], ["./x", "T", "T", true], ["../y.js", null, "ns", false], ["./u", "U", "U", true], ["./effect", null, "", false], ["./z", null, "", false], ["./all", null, "", false],
  ]);
  assert.deepEqual(facts.bindings.filter(b => b.kind === "import").map(b => [b.name, b.hoisted]), [["d", true], ["b", true], ["ns", true]], "type-only imports bind no runtime value");
  assert.deepEqual(facts.exports.map(e => [e.exportedName, e.module ?? null, e.importedName ?? null, e.localName ?? null]), [["zz", "./z", "z", null], ["*", "./all", "*", null], ["renamed", null, null, "local"]]);
});

test("calls keep static dotted paths only; callbacks get their own scope; block bindings are conditional", async () => {
  const facts = await extract(`import * as ns from './n';\nfunction f(p) {\n  ns.g(p); p.h(); this.k(); obj?.m();\n  [1].map(x => helper(x));\n  if (p) { const helper = 1; }\n  new Thing();\n  require('./r'); eval('1');\n}\n`);
  const calls = facts.calls.map(c => [c.expression, c.parts.join("."), !!c.lookupScopeId]);
  assert.deepEqual(calls, [["ns.g", "ns.g", false], ["p.h", "p.h", false], ["this.k", "", false], ["obj?.m", "", false], ["[1].map", "", false], ["helper", "helper", true], ["Thing", "Thing", false], ["eval", "eval", false]], "eval is a recorded call site that also makes its scope opaque");
  assert.equal(facts.bindings.find(b => b.name === "helper").conditional, true);
  assert.equal(facts.bindings.find(b => b.name === "p").kind, "unknown");
  assert.equal(facts.scopes.find(s => s.id === facts.symbols.find(x => x.name === "f").id).opaque, true, "eval makes its scope opaque");
  assert.ok(facts.diagnostics.some(d => /require/.test(d)));
});

test("TSX parses with the TSX grammar and syntax errors mark the file incomplete", async () => {
  const tsx = await extract(`export function View() { return <div onClick={() => go()} />; }\n`, "src/view.tsx");
  assert.equal(tsx.parseComplete, true); assert.ok(tsx.calls.some(c => c.expression === "go"));
  const broken = await extract(`export function x( {\n`);
  assert.equal(broken.parseComplete, false); assert.ok(broken.diagnostics.some(d => /Syntax errors/.test(d)));
});

test("extraction limits are enforced", async () => {
  await assert.rejects(extractor.extract({ snapshotId: "s", path: "a.ts", source: Array.from({ length: 50 }, (_, i) => `function f${i}() {}`).join("\n") }, { maxFacts: 10 }), /fact limit/);
});

test("declarations hash signatures and bodies so change detection is identity-stable", () => {
  const base = extractor.declarations("src/a.ts", `export function f(a: number) { return a; }\nclass C { get v() { return 1 } m() { return 2 } }\nimport { x } from './x';\n`);
  const head = extractor.declarations("src/a.ts", `export function f(a: number) { return a + 1; }\nclass C { get v() { return 1 } m(b: string) { return 2 } }\nimport { x } from './x';\n`);
  assert.deepEqual(base.declarations.map(d => [d.kind, d.scope, d.name, d.role]), [["function", "", "f", "none"], ["class", "", "C", "none"], ["method", "C", "v", "getter"], ["method", "C", "m", "none"], ["from_import", "", "x", "none"]]);
  const changes = matchDeclarations(base.declarations, head.declarations, "s");
  assert.deepEqual(changes.map(c => [c.head?.name, c.changeType]).sort(), [["f", "body_changed"], ["m", "signature_changed"]]);
  assert.deepEqual(base.declarations.at(-1).importItem, { module: "./x", importedName: "x", localBinding: "x", relativeLevel: 0, reexport: false, uncertain: false });
});

test("receiver navigation finds this.member() in methods, not in rebinding functions", () => {
  const calls = extractor.receiverCalls(`class A {\n  m() { this.n(); [1].map(() => this.o()); function g() { this.p(); } }\n  n() {}\n}\n`);
  assert.deepEqual(calls.map(c => [c.member, c.callerLine, c.classLine]), [["n", 2, 1], ["o", 2, 1]]);
});

test("module resolution honours tsconfig paths, .js specifiers and index files inside the snapshot only", async () => {
  const files = { "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } } }', "src/lib/a.ts": "", "src/lib/index.ts": "", "src/b.tsx": "", "types/x.d.ts": "", "package.json": "{}" };
  const resolve = await createSpecifierResolver({ snapshotId: "s", paths: Object.keys(files), readText: async path => files[path] });
  assert.equal(resolve("./lib/a.js", "src/main.ts"), "src/lib/a.ts");
  assert.equal(resolve("@lib/a", "src/main.ts"), "src/lib/a.ts");
  assert.equal(resolve("./lib", "src/main.ts"), "src/lib/index.ts");
  assert.equal(resolve("./b", "src/main.ts"), "src/b.tsx");
  assert.equal(resolve("react", "src/main.ts"), undefined);
  assert.equal(resolve("../types/x", "src/main.ts"), undefined, "declaration files are not runtime modules");
  assert.equal(resolve("./missing", "src/main.ts"), undefined);
});

test("a tampered TypeScript grammar is rejected rather than silently replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ts-grammar-")); const path = join(directory, "bad.wasm"); await writeFile(path, "not a grammar");
  await assert.rejects(TypeScriptTreeSitterExtractor.create({ typescript: path }), /typescript grammar SHA-256/);
});
