import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { repositoryFixture } from './repository-fixture.mjs';

async function fixture(t) {
  const f = await repositoryFixture(t, {
    'docs/a.txt': 'keep_attrs docs\nkeep_attrs more docs\n',
    'src/a.py': 'keep_attrs first\nkeep_attrs second\n',
    'src/b.py': 'keep_attrs third\n',
    'src-other/c.py': 'keep_attrs outside\n',
  });
  return { f, store: await SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head: f.base }, configuration: {} }) };
}

test('source range completion is independent of the remainder of the file and its evidence hash', async t => {
  const { store } = await fixture(t);
  const first = await store.source('head', 'src/a.py', 1, 1);
  assert.equal(first.truncated, false); assert.equal(first.hasMoreLines, true);
  assert.equal(first.text, 'keep_attrs first');
  assert.deepEqual(await store.read(first), { text: first.text, actualSha256: first.contentSha256 });
  const eof = await store.source('head', 'src/a.py', 2, 10);
  assert.equal(eof.endLine, 2); assert.equal(eof.truncated, false); assert.equal(eof.hasMoreLines, false);
});

test('scoped literal search escapes noisy earlier files and paginates without losing or repeating matches', async t => {
  const { store } = await fixture(t);
  const all = await store.search('head', 'keep_attrs', 100, { path: 'src/' });
  const found = []; let cursor;
  do {
    const page = await store.search('head', 'keep_attrs', 1, { path: 'src/', cursor });
    found.push(...page.items); cursor = page.nextCursor;
    assert.equal(page.truncated, cursor !== undefined);
    assert.equal(page.coverage.scopedFiles, 2);
  } while (cursor);
  assert.deepEqual(found, all.items);
  assert.deepEqual(found.map(x => [x.path, x.line]), [['src/a.py', 1], ['src/a.py', 2], ['src/b.py', 1]]);
  assert.equal((await store.search('head', 'keep_attrs', 100, { path: 'src/b.py' })).items.length, 1);
  await assert.rejects(store.search('head', 'keep_attrs', 1, { path: '../src/' }), /Unsafe/);
  await assert.rejects(store.search('head', 'keep_attrs', 1, { path: 'missing.py' }), /absent/);
});

test('search cursors reject changed query, revision, scope and snapshot', async t => {
  const { f, store } = await fixture(t);
  const { nextCursor: cursor } = await store.search('head', 'keep_attrs', 1, { path: 'src/' });
  for (const [revision, query, path] of [['base', 'keep_attrs', 'src/'], ['head', 'other', 'src/'], ['head', 'keep_attrs', 'docs/']]) {
    await assert.rejects(store.search(revision, query, 1, { path, cursor }), /Invalid search cursor/);
  }
  await assert.rejects(store.search('head', 'keep_attrs', 1, { path: 'src/', cursor: 'broken' }), /Invalid search cursor/);
  const head = await f.commit();
  const other = await SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, configuration: {} });
  await assert.rejects(other.search('head', 'keep_attrs', 1, { path: 'src/', cursor }), /Invalid search cursor/);
});

test('byte-limited search can continue at the first omitted match', async t => {
  const f = await repositoryFixture(t, { 'large.py': Array.from({ length: 100 }, (_, i) => `match ${i} ${'字'.repeat(450)}`).join('\n') });
  const store = await SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head: f.base }, configuration: {} });
  const found = []; let cursor;
  do { const page = await store.search('head', 'match', 100, { cursor }); found.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(found.map(x => x.line), Array.from({ length: 100 }, (_, i) => i + 1));
});
