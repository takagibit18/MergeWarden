import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { language, loadExtractor } from '../src/graph/languages/index.ts';
import { typescript, classifyTypeScriptPath, relativeCandidates } from '../src/graph/languages/typescript.ts';
import { StructureIndexer } from '../src/graph/structure-indexer.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { DEFAULT_GRAPH_BUDGET, graphBuildLockPath, graphCacheDir, graphLanguageKey, publishedGraphPath, readGraphEntities, readGraphRelations, SqliteCodeGraph } from '../src/graph/sqlite-store.ts';
import { snapshotChanges } from '../src/engine/snapshot-changes.ts';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { readRun } from '../src/engine/reports.ts';
import { LazyCodeGraph } from '../src/graph/lazy-graph.ts';
import { resolveChangeHints } from '../src/engine/change-resolution.ts';
import { repositoryFixture } from './repository-fixture.mjs';

/** Pure pipeline: extract → resolve → structure, returning all relations with readable labels. */
async function relations(files) {
  const extractor = await loadExtractor(typescript); const snapshotId = 'ts-resolver';
  try {
    const paths = Object.keys(files); const resolver = await typescript.createResolver({ snapshotId, paths, readText: async path => files[path] });
    const facts = []; for (const path of paths.filter(typescript.owns)) facts.push(await extractor.extract({ snapshotId, path, source: files[path] }));
    for (const fact of facts) resolver.index(fact); resolver.finalize();
    const entities = new StructureIndexer(snapshotId, [typescript.versions.resolver]).entities(resolver.languageEntities); const byId = new Map(entities.map(e => [e.id, e]));
    const name = id => { const e = byId.get(id); return e ? (e.kind === 'file' ? e.path : `${e.path}#${e.name}`) : '?'; };
    const edges = facts.flatMap(fact => resolver.resolveFile(fact)).map(r => [r.relation, r.resolution, name(r.fromId), name(r.toId)]);
    const sites = facts.flatMap(fact => fact.calls).map(c => [c.expression, c.resolution, c.ruleSource]);
    return { edges, sites };
  } finally { extractor.dispose(); }
}
const calls = edges => edges.filter(e => e[0] === 'CALLS').map(e => `${e[1]} ${e[2]} -> ${e[3]}`);

test('re-export chains, barrels and default exports resolve; cycles and ambiguity never become definite', async () => {
  const { edges, sites } = await relations({
    'src/a.ts': 'export function a() {}\nexport function dup() {}\n', 'src/b.ts': 'export function dup() {}\n',
    'src/barrel.ts': "export * from './a';\nexport * from './b';\nexport { a as renamed } from './a';\nexport { default as Widget } from './widget';\n",
    'src/widget.ts': 'export default class Widget {}\n',
    'src/loop1.ts': "export * from './loop2';\n", 'src/loop2.ts': "export * from './loop1';\n",
    'src/use.ts': "import { a, renamed, dup, Widget } from './barrel';\nimport { ghost } from './loop1';\nexport function run() { a(); renamed(); dup(); ghost(); return new Widget(); }\n",
  });
  assert.deepEqual(calls(edges).sort(), ['resolved_import_alias src/use.ts#run -> src/a.ts#a', 'resolved_import_alias src/use.ts#run -> src/a.ts#a', 'resolved_import_alias src/use.ts#run -> src/widget.ts#Widget'].sort());
  assert.deepEqual(sites.find(s => s[0] === 'dup').slice(1), ['candidate', 'ambiguous_star_reexport']);
  assert.equal(sites.find(s => s[0] === 'ghost')[1], 'unresolved');
});

test('hoisting, temporal dead zone, conditional bindings and callbacks follow the lexical rules', async () => {
  const { edges, sites } = await relations({
    'src/m.ts': "early();\nfunction early() {}\nlate();\nconst late = () => 1;\nexport function f(flag: boolean) {\n  if (flag) { var maybe = () => 1; }\n  maybe();\n  [1].forEach(x => early());\n}\n",
  });
  assert.deepEqual(calls(edges).sort(), ['resolved_scoped src/m.ts#f -> src/m.ts#early', 'resolved_scoped src/m.ts -> src/m.ts#early'].sort());
  assert.equal(sites.find(s => s[0] === 'late')[2], 'binding_used_before_definition');
  assert.equal(sites.find(s => s[0] === 'maybe')[1], 'candidate');
});

test('object-literal method parameters and a named function expression shadow outer functions', async () => {
  const { edges } = await relations({
    'src/m.ts': "function helper() {}\nfunction g() {}\nfunction cb() {}\n"
      + "export const api = { run(helper: () => void) { helper(); }, get v() { return cb(); }, k: function (cb: () => void) { cb(); } };\n"
      + "export const f = function g() { g(); };\n",
  });
  assert.deepEqual(calls(edges).sort(), ['resolved_scoped src/m.ts -> src/m.ts#cb', 'resolved_scoped src/m.ts#f -> src/m.ts#f'].sort(),
    'only the getter reaches the module cb; the parameter and the expression name never resolve to outer functions');
});

test('an unavailable .tsx file does not hide the .ts module with the same module name', async () => {
  const extractor = await loadExtractor(typescript); const snapshotId = 'ts-unavailable';
  const files = { 'src/a.ts': 'export function x() {}\n', 'src/a.tsx': 'export function x() {}\n', 'src/u.ts': "import { x } from './a';\nexport function f() { x(); }\n" };
  try {
    const paths = Object.keys(files); const resolver = await typescript.createResolver({ snapshotId, paths, readText: async path => files[path] });
    resolver.markModuleUnavailable(typescript.moduleName('src/a.tsx'), 'src/a.tsx');
    const facts = []; for (const path of ['src/a.ts', 'src/u.ts']) facts.push(await extractor.extract({ snapshotId, path, source: files[path] }));
    for (const fact of facts) resolver.index(fact); resolver.finalize();
    const called = facts.flatMap(fact => resolver.resolveFile(fact)).filter(r => r.relation === 'CALLS');
    assert.equal(called.length, 1); assert.equal(called[0].resolution, 'resolved_import_alias');
  } finally { extractor.dispose(); }
});

test('a changed TypeScript import resolves to the imported entity for change-aware dispatch', async () => {
  const extractor = await loadExtractor(typescript);
  try {
    const util = await extractor.extract({ snapshotId: 's', path: 'src/util.ts', source: 'export function helper() {}\n' });
    const declaration = extractor.declarations('src/use.ts', "import { helper } from './util';\n").declarations.find(d => d.importItem);
    const [resolved] = resolveChangeHints(util.symbols, 's', [{ path: 'src/use.ts', startLine: 1, endLine: 1, declaration: { match: 'matched', head: declaration } }]);
    assert.equal(resolved.status, 'resolved'); assert.deepEqual(resolved.items.map(item => item.qualifiedName), ['src/util.helper']);
  } finally { extractor.dispose(); }
});

test('a module with syntax errors is not a resolution target', async () => {
  const { edges, sites } = await relations({ 'src/bad.ts': 'export function x( {\n', 'src/use.ts': "import { x } from './bad';\nexport function run() { x(); }\n" });
  assert.equal(calls(edges).length, 0); assert.equal(sites[0][2], 'module_parse_incomplete');
});

test('TypeScript path policy mirrors the Python one and the descriptor owns runtime sources only', () => {
  assert.deepEqual(['src/a.ts', 'src/a.test.ts', 'src/__tests__/b.ts', 'node_modules/x/y.ts', 'src/gen/x.ts', 'src/x.stories.tsx', 'bench/x.ts', 'src/contest.ts'].map(classifyTypeScriptPath),
    ['production', 'test', 'test', 'vendor', 'generated', 'example', 'benchmark', 'production']);
  assert.equal(typescript.owns('a.d.ts'), false); assert.equal(typescript.owns('a.tsx'), true); assert.equal(typescript.owns('a.js'), false);
  assert.deepEqual(relativeCandidates('./lib/a.js', 'src/m.ts').slice(0, 2), ['src/lib/a.ts', 'src/lib/a.tsx']);
  assert.deepEqual(relativeCandidates('react', 'src/m.ts'), []); assert.deepEqual(relativeCandidates('../../x', 'a.ts'), []);
  assert.equal(language('typescript'), typescript);
});

const MIXED = {
  'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["web/lib/*"] } } }',
  'web/lib/math.ts': 'export function add(a: number, b: number) { return a + b; }\n',
  'web/app.ts': "import { add } from '@lib/math';\nexport function total() { return add(1, 2); }\n",
  'svc/core.py': 'def add(a, b):\n    return a + b\n', 'svc/use.py': 'from svc.core import add\n\ndef total():\n    return add(1, 2)\n',
};
async function mixed(t) {
  const f = await repositoryFixture(t, MIXED); await f.write('web/lib/math.ts', 'export function add(a: number, b: number) { return a + b + 0; }\n'); const head = await f.commit();
  return { ...f, head, store: await SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, configuration: { provider: 'fixture', modelId: 'offline', policy: 'final_only', promptVersion: 1 } }) };
}

test('a mixed repository builds one graph with per-language coverage and no cross-language edges', async t => {
  const { store } = await mixed(t); const id = store.manifest.identity.id; const languages = ['python', 'typescript'];
  const { graph, metrics } = await SqliteCodeGraph.open(store, { languages });
  const page = await graph.lookup({ snapshotId: id, query: 'add', limit: 10 }); graph.close();
  assert.deepEqual(page.items.filter(item => item.kind === 'function').map(item => item.path).sort(), ['svc/core.py', 'web/lib/math.ts']);
  assert.deepEqual(Object.keys(metrics.coverage.byLanguage), languages); assert.equal(metrics.coverage.byLanguage.typescript.indexedFiles, 2);
  assert.notEqual(graphCacheDir(store.stateDir, id, DEFAULT_GRAPH_BUDGET, 'core', graphLanguageKey(store, languages)), graphCacheDir(store.stateDir, id), 'a multi-language graph has its own identity');
  const db = new DatabaseSync(await publishedGraphPath(store.stateDir, id, DEFAULT_GRAPH_BUDGET, 'core', graphLanguageKey(store, languages)), { readOnly: true });
  const entities = new Map(readGraphEntities(db, id).map(e => [e.id, e])); const edges = readGraphRelations(db, id).filter(r => r.relation !== 'CONTAINS'); db.close();
  const ext = id => entities.get(id).path.split('.').at(-1);
  assert.ok(edges.length >= 4); assert.ok(edges.every(r => ext(r.fromId) === ext(r.toId)), 'no edge crosses languages');
  assert.ok(edges.some(r => r.relation === 'CALLS' && entities.get(r.toId).path === 'web/lib/math.ts'), 'tsconfig paths alias resolves');
  const python = await SqliteCodeGraph.open(store); python.graph.close();
  assert.equal(python.metrics.coverage.byLanguage, undefined, 'Python-only coverage keeps its Graph v4 shape');
});

test('declaration changes are detected for every enabled language with declarations', async t => {
  const { store } = await mixed(t);
  assert.deepEqual((await snapshotChanges(store)).length, 0, 'the legacy default parses only Python');
  const changes = await snapshotChanges(store, ['python', 'typescript']);
  assert.deepEqual(changes.map(c => [c.path, c.head?.name, c.changeType]), [['web/lib/math.ts', 'add', 'body_changed']]);
});

const runtime = script => async options => ({ journal: new MemoryJournal(), async prompt() { await script(Object.fromEntries(options.tools.map(t => [t.name, t])), options.tools); }, async abort() {}, dispose() {}, usage: () => ({ input: 0, output: 0, total: 0 }) });
test('product reviews enable TypeScript while evaluations stay Python-only, and tool descriptions name the languages', async t => {
  const f = await mixed(t); const base = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head: f.head }, model: { provider: 'fixture', modelId: 'offline' } };
  let description, found;
  const product = await new ReviewEngine(runtime(async tools => {
    description = tools.graph_lookup.description; found = await tools.graph_lookup.execute({ query: 'web/lib/math.ts', limit: 5 });
    await tools.read_diff.execute({ path: 'web/lib/math.ts' }); await tools.submit_review.execute({ summary: 'mixed', reviewedPaths: ['web/lib/math.ts'], findings: [] });
  })).run(base);
  assert.match(description, /changed or relevant Python\/TypeScript directory/); assert.ok(found.items.some(item => item.kind === 'file' && item.path === 'web/lib/math.ts'), 'TypeScript entities are indexed in a product review');
  assert.deepEqual((await readRun(f.state, product.runId)).graphLanguages, ['python', 'typescript']);
  const evaluation = await new ReviewEngine(runtime(async tools => {
    description = tools.graph_lookup.description; await tools.read_diff.execute({ path: 'web/lib/math.ts' }); await tools.submit_review.execute({ summary: 'eval', reviewedPaths: ['web/lib/math.ts'], findings: [] });
  })).run({ ...base, evaluation: { tools: 'text+graph' } });
  assert.match(description, /changed or relevant Python directory/);
  assert.deepEqual((await readRun(f.state, evaluation.runId)).graphLanguages, ['python']);
  await assert.rejects(new ReviewEngine(runtime(async () => {})).run({ ...base, languages: ['cobol'] }), /Unknown graph language/);
  const text = JSON.parse(await readFile(join(f.state, 'runs', product.runId, 'run.json'), 'utf8'));
  assert.equal(text.navigation.state, 'recorded');
});

test('a lazy multi-language graph releases its own build lock on dispose', async t => {
  const { store } = await mixed(t); const id = store.manifest.identity.id; const languages = ['python', 'typescript'];
  const lazy = new LazyCodeGraph(store.stateDir, id, { languages });
  const lock = graphBuildLockPath(store.stateDir, id, DEFAULT_GRAPH_BUDGET, 'core', graphLanguageKey(store, languages));
  await mkdir(dirname(lock), { recursive: true }); await writeFile(lock, JSON.stringify({ pid: process.pid, ownerToken: lazy.ownerToken }));
  await lazy.dispose();
  await assert.rejects(access(lock), { code: 'ENOENT' });
  const opened = await SqliteCodeGraph.open(store, { languages }); opened.graph.close();
});

test('reruns keep their run\'s graph languages and historical runs rerun Python-only', async t => {
  const f = await mixed(t); const base = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head: f.head }, model: { provider: 'fixture', modelId: 'offline' } };
  const review = new ReviewEngine(runtime(async tools => { await tools.read_diff.execute({ path: 'web/lib/math.ts' }); await tools.submit_review.execute({ summary: 'r', reviewedPaths: ['web/lib/math.ts'], findings: [] }); }));
  const first = await review.run(base);
  const rerun = await review.run({ ...base, input: undefined, rerunId: first.runId });
  assert.deepEqual((await readRun(f.state, rerun.runId)).graphLanguages, ['python', 'typescript']);
  const path = join(f.state, 'runs', first.runId, 'run.json'); const historical = JSON.parse(await readFile(path, 'utf8')); delete historical.graphLanguages;
  await writeFile(path, JSON.stringify(historical, null, 2) + '\n');
  const legacy = await review.run({ ...base, input: undefined, rerunId: first.runId });
  assert.deepEqual((await readRun(f.state, legacy.runId)).graphLanguages, ['python']);
});
