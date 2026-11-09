import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { DEFAULT_GRAPH_BUDGET, GRAPH_SCHEMA_VERSION, graphCacheDir, graphLanguageKey, publishedGraphPath, readGraphEntities, readGraphRelations, SqliteCodeGraph } from '../src/graph/sqlite-store.ts';
import { resolvePython, RESOLVER_VERSION } from '../src/graph/python-resolver.ts';
import { languageCatalog, pythonCatalog } from '../src/graph/scope-policy.ts';
import { DEFAULT_LANGUAGE_IDS, effectiveLanguages, enabledLanguages, languageForPath, languageIdentity, LANGUAGES, loadExtractor } from '../src/graph/languages/index.ts';
import { python } from '../src/graph/languages/python.ts';
import { StructureIndexer } from '../src/graph/structure-indexer.ts';
import { sha256 } from '../src/infrastructure/files.ts';
import { repositoryFixture } from './repository-fixture.mjs';

const FILES = {
  'pkg/__init__.py': 'from .core import Engine\n',
  'pkg/core.py': 'from .util import helper as h\n\nclass Base:\n    def run(self):\n        return h(1)\n\nclass Engine(Base):\n    def start(self):\n        return self.run()\n\ndef build():\n    return Engine()\n',
  'pkg/util.py': 'def helper(x):\n    return x + 1\n',
  'app.py': 'from pkg.core import build\nimport pkg.util\n\ndef main():\n    pkg.util.helper(3)\n    return build().start()\n',
  'tests/test_app.py': 'from app import main\n\ndef test_main():\n    assert main()\n',
  'web/index.ts': 'export function f() { return 1 }\n',
};
async function frozen(t) {
  const f = await repositoryFixture(t, FILES); await f.write('pkg/util.py', 'def helper(x):\n    return x + 2\n'); const head = await f.commit();
  return SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, configuration: { provider: 'p', modelId: 'm', policy: 'final_only', promptVersion: 1 } });
}

test('a Python-only graph keeps the Graph v4 cache identity formula exactly', async t => {
  const store = await frozen(t); const id = store.manifest.identity.id;
  const legacy = sha256(JSON.stringify({ snapshotId: id, schema: 4, resolver: 'python-entities-streaming-5', parser: 'web-tree-sitter-0.27.0/python-0.25.0-abi15', policy: 'python-entity-core-2/python-core-scope-2', scope: 'core', budget: DEFAULT_GRAPH_BUDGET }));
  assert.equal(GRAPH_SCHEMA_VERSION, 4);
  assert.equal(basename(graphCacheDir(store.stateDir, id)), legacy);
  assert.equal(basename(graphCacheDir(store.stateDir, id, DEFAULT_GRAPH_BUDGET, 'core', graphLanguageKey(store, ['python']))), legacy);
  assert.deepEqual(languageIdentity([python]), { ids: ['python'], parser: python.versions.parser, resolver: RESOLVER_VERSION, policy: python.versions.policy, resolvers: [RESOLVER_VERSION] });
});

test('the language-pack build publishes the same entities and resolved relations as the standalone Python resolver', async t => {
  const store = await frozen(t); const id = store.manifest.identity.id;
  const { graph } = await SqliteCodeGraph.open(store, { scope: 'all' }); graph.close();
  const db = new DatabaseSync(await publishedGraphPath(store.stateDir, id, DEFAULT_GRAPH_BUDGET, 'all'), { readOnly: true });
  const published = { entities: readGraphEntities(db, id), relations: readGraphRelations(db, id) }; db.close();
  const extractor = await loadExtractor(python); let standalone;
  try {
    const paths = pythonCatalog(store.manifest.head, store.manifest.changedPaths, 'all').map(entry => entry.path);
    standalone = resolvePython(await Promise.all(paths.map(async path => extractor.extract({ snapshotId: id, path, source: await store.text('head', path) }))), { snapshotId: id });
  } finally { extractor.dispose(); }
  const entity = e => JSON.stringify([e.id, e.kind, e.functionKind ?? null, e.path, e.qualifiedName, e.name, e.startLine, e.endLine, e.parentSymbolId ?? null]);
  assert.deepEqual(published.entities.map(entity).sort(), standalone.entities.map(entity).sort());
  const edge = e => JSON.stringify([e.fromId, e.toId, e.relation, e.resolution]);
  const resolved = standalone.relations.filter(e => e.resolution === 'resolved_scoped' || e.resolution === 'resolved_import_alias');
  assert.deepEqual(published.relations.map(edge).sort(), [...new Set(resolved.map(edge))].sort());
  assert.ok(published.relations.some(e => e.relation === 'INHERITS') && published.relations.some(e => e.relation === 'CALLS'));
  assert.ok(!published.entities.some(e => e.path.endsWith('.ts')), 'a language that is not enabled is not indexed');
});

test('the structure indexer reproduces resolver-owned directories and CONTAINS ids', async t => {
  const store = await frozen(t); const id = store.manifest.identity.id; const extractor = await loadExtractor(python);
  try {
    const facts = await Promise.all(['app.py', 'pkg/core.py'].map(async path => extractor.extract({ snapshotId: id, path, source: await store.text('head', path) })));
    const standalone = resolvePython(structuredClone(facts), { snapshotId: id });
    const resolver = await python.createResolver({ snapshotId: id, paths: [], readText: async () => '' });
    for (const fact of structuredClone(facts)) resolver.index(fact); resolver.finalize();
    assert.ok(resolver.languageEntities.every(e => e.kind !== 'directory'));
    const structure = new StructureIndexer(id, [RESOLVER_VERSION]); const entities = structure.entities(resolver.languageEntities);
    assert.deepEqual(entities.map(e => JSON.stringify(e)).sort(), standalone.entities.map(e => JSON.stringify(e)).sort());
    const contains = standalone.relations.filter(e => e.relation === 'CONTAINS');
    assert.deepEqual(structure.relations(entities).map(e => e.id).sort(), contains.map(e => e.id).sort());
    assert.match(new StructureIndexer(id, ['a', 'b']).version, /^structure-1\(a\+b\)$/);
  } finally { extractor.dispose(); }
});

test('language selection is validated, ordered by the manifest and falls back to a stable identity', () => {
  assert.deepEqual(enabledLanguages().map(l => l.id), [...DEFAULT_LANGUAGE_IDS]);
  for (const bad of [[], ['python', 'python'], ['cobol']]) assert.throws(() => enabledLanguages(bad));
  assert.deepEqual(effectiveLanguages(['python'], ['README.md']).map(l => l.id), ['python']);
  assert.equal(languageForPath('a/b.py')?.id, 'python'); assert.equal(languageForPath('README.md'), undefined);
  assert.deepEqual(languageCatalog({ 'a.py': { hash: 'h', bytes: 1, status: 'text', mode: '100644' }, 'b.md': { hash: 'h', bytes: 1, status: 'text', mode: '100644' } }, [], 'core', [python]).map(e => [e.path, e.language]), [['a.py', 'python']]);
  for (const language of LANGUAGES) {
    assert.ok(/^[a-z]+$/.test(language.id) && language.displayName && language.versions.parser && language.versions.resolver && language.versions.policy, language.id);
    assert.ok(language.capabilities.relations.includes('CONTAINS'), `${language.id} declares its relations`);
  }
});

test('only language descriptors know where parser adapters live', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url)); const offenders = [];
  const walk = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.ts') && (await readFile(path, 'utf8')).includes('integrations/tree-sitter')) offenders.push(relative(root, path).split(sep).join('/'));
  } };
  await walk(root);
  assert.deepEqual(offenders.filter(path => !path.startsWith('graph/languages/')), []);
});
