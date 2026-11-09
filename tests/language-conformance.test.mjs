import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, language as languageById, loadExtractor } from '../src/graph/languages/index.ts';
import { StructureIndexer } from '../src/graph/structure-indexer.ts';
import { CASES, FIXTURES } from './languages/conformance.mjs';

/** The production pipeline without SQLite: extract, index, finalize, resolve, add structure. */
async function graph(languageId, files) {
  const descriptor = languageById(languageId); const extractor = await loadExtractor(descriptor);
  try {
    const paths = Object.keys(files); const snapshotId = `conformance-${languageId}`;
    const resolver = await descriptor.createResolver({ snapshotId, paths, readText: async path => files[path] });
    const facts = []; for (const path of paths.filter(path => descriptor.owns(path))) facts.push(await extractor.extract({ snapshotId, path, source: files[path] }));
    for (const fact of facts) resolver.index(fact); resolver.finalize();
    const structure = new StructureIndexer(snapshotId, [descriptor.versions.resolver]); const entities = structure.entities(resolver.languageEntities);
    const relations = [...structure.relations(entities), ...facts.flatMap(fact => resolver.resolveFile(fact))];
    const byId = new Map(entities.map(entity => [entity.id, entity]));
    const label = id => { const entity = byId.get(id); return entity ? `${descriptor.moduleName(entity.path)}#${entity.kind === 'file' ? '<file>' : entity.name}` : '?'; };
    return relations.filter(r => r.resolution === 'resolved_scoped' || r.resolution === 'resolved_import_alias').map(r => [r.relation, label(r.fromId), label(r.toId)]);
  } finally { extractor.dispose(); }
}

for (const descriptor of LANGUAGES) for (const item of CASES) {
  const files = FIXTURES[descriptor.id]?.[item.id];
  test(`${descriptor.id} conformance: ${item.rule}`, { skip: files ? false : 'declared not supported' }, async () => {
    const edges = await graph(descriptor.id, files); const has = ([relation, from, to]) => edges.some(e => e[0] === relation && e[1] === from && (to === '*' || e[2] === to));
    for (const edge of item.edges) assert.ok(has(edge), `missing ${edge.join(' ')} in ${JSON.stringify(edges)}`);
    for (const edge of item.absent ?? []) assert.ok(!has(edge), `unexpected ${edge.join(' ')}`);
  });
}

test('every registered language provides a fixture for every conformance case', () => {
  for (const descriptor of LANGUAGES) assert.deepEqual(Object.keys(FIXTURES[descriptor.id] ?? {}).sort(), CASES.map(item => item.id).sort(), descriptor.id);
});
