import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { isolatedState, atomicWrite, sha256 } from '../src/infrastructure/files.ts';
import { repositoryFixture } from './repository-fixture.mjs';
const freeze = (f, input, hooks) => SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state, input, configuration: { test: true } }, hooks);

test('commit snapshot is immutable; evidence and literal search bind to a revision', async t => {
  const f = await repositoryFixture(t); const head = await f.change(); const s = await freeze(f, { kind: 'commits', base: f.base, head });
  await f.write('app.py', 'changed after review\n');
  assert.match(await s.text('base', 'app.py'), /max/); assert.doesNotMatch(await s.text('head', 'app.py'), /max/);
  const evidence = await s.source('head', 'app.py', 1, 2); assert.equal(evidence.contentSha256, sha256(evidence.text));
  assert.deepEqual(await s.read(evidence), { text: evidence.text, actualSha256: evidence.contentSha256 });
  assert.equal((await s.search('base', 'max')).items.length, 1); assert.equal((await s.search('head', 'max')).items.length, 0);
  assert.deepEqual((await SnapshotStore.load(f.state, s.manifest.identity.id)).manifest, s.manifest);
  await assert.rejects(s.text('head', '../app.py'), /Unsafe/);
  await assert.rejects(s.read({ ...evidence, snapshotId: 'wrong' }), /snapshot/);
});

test('partial staging keeps HEAD, index, and saved disk versions distinct', async t => {
  const f = await repositoryFixture(t); await f.write('app.py', 'staged\n'); await f.git('add', 'app.py'); await f.write('app.py', 'saved\n');
  const staged = await freeze(f, { kind: 'staged' }); const worktree = await freeze(f, { kind: 'worktree' });
  assert.equal(await staged.text('head', 'app.py'), 'staged\n'); assert.equal(await worktree.text('head', 'app.py'), 'saved\n');
  assert.equal(staged.manifest.identity.headCommit, undefined); assert.equal(staged.manifest.identity.headVersion.kind, 'content');
  assert.notEqual(staged.manifest.identity.id, worktree.manifest.identity.id);
});

test('Chinese rename and deletion remain accessible at the correct version', async t => {
  const f = await repositoryFixture(t, { '旧名.py': 'hello\n', 'delete.py': 'remove\n' });
  await f.git('mv', '旧名.py', '新名.py'); await f.git('rm', 'delete.py'); const head = await f.commit();
  const s = await freeze(f, { kind: 'commits', base: f.base, head });
  assert.deepEqual(s.manifest.changedPaths.sort(), ['delete.py', '新名.py', '旧名.py'].sort());
  assert.equal(await s.text('base', '旧名.py'), 'hello\n'); assert.equal(await s.text('head', '新名.py'), 'hello\n');
  assert.ok((await s.diff('delete.py')).lines.includes('+++ /dev/null'));
});

test('untracked files require selection and ignored files cannot be selected', async t => {
  const f = await repositoryFixture(t, { 'app.py': 'a\n', '.gitignore': 'secret.txt\n' });
  await f.write('extra.py', 'extra\n'); await f.write('secret.txt', 'secret\n');
  assert.deepEqual((await freeze(f, { kind: 'worktree' })).manifest.changedPaths, []);
  assert.deepEqual((await freeze(f, { kind: 'worktree', includeUntracked: ['extra.py'] })).manifest.changedPaths, ['extra.py']);
  await assert.rejects(freeze(f, { kind: 'worktree', includeUntracked: ['secret.txt'] }), /eligible/);
});

test('freezing rejects a concurrent worktree or index change', async t => {
  const f = await repositoryFixture(t); await f.write('app.py', 'first\n');
  await assert.rejects(freeze(f, { kind: 'worktree' }, { beforeVerify: () => f.write('app.py', 'second\n') }), /changed during capture/);
  await assert.rejects(freeze(f, { kind: 'staged' }, { beforeVerify: () => f.git('add', 'app.py') }), /changed during capture/);
});

test('distinct commits with identical trees have distinct identities; same snapshot is reused', async t => {
  const f = await repositoryFixture(t); const a = await f.commit(); const b = await f.commit();
  const sa = await freeze(f, { kind: 'commits', base: f.base, head: a }); const sb = await freeze(f, { kind: 'commits', base: f.base, head: b });
  assert.notEqual(sa.manifest.identity.id, sb.manifest.identity.id);
  assert.deepEqual((await freeze(f, { kind: 'commits', base: f.base, head: a })).manifest, sa.manifest);
});

test('diff pagination and source output bounds expose truncation', async t => {
  const f = await repositoryFixture(t, { 'app.py': 'original\n' }); await f.write('app.py', Array.from({length: 250}, (_, i) => `line ${i}`).join('\n')); const head = await f.commit();
  const s = await freeze(f, { kind: 'commits', base: f.base, head }); let cursor = 0; const lines = [];
  do { const page = await s.diff('app.py', cursor, 25); lines.push(...page.lines); cursor = page.nextCursor; } while (cursor !== undefined);
  assert.ok(lines.includes('+line 249'));
  const source = await s.source('head', 'app.py', 1, 200);
  assert.equal(source.truncated, false); assert.equal(source.hasMoreLines, true);
  await assert.rejects(s.source('head', 'app.py', 1, 201), /200/);
  assert.equal((await s.search('head', 'line', 1)).truncated, true);
});

test('binary and symbolic link blobs cannot masquerade as reviewable text', async t => {
  const f = await repositoryFixture(t); await f.write('binary.bin', Buffer.from([0, 1, 2]));
  // Populate a Git symlink without requiring Windows symlink privileges.
  await f.write('link-target', '../outside'); const linkOid = await f.git('hash-object', '-w', 'link-target');
  await f.git('update-index', '--add', '--cacheinfo', '120000', linkOid, 'link.py'); await f.git('add', 'binary.bin');
  const s = await freeze(f, { kind: 'staged' });
  assert.equal(s.manifest.head['link.py'].status, 'symlink'); assert.equal((await s.diff('link.py')).status, 'unavailable');
  assert.equal((await s.diff('binary.bin')).status, 'unavailable');
});

test('snapshot rejects tampered content or coverage', async t => {
  const f = await repositoryFixture(t); const head = await f.change(); const s = await freeze(f, { kind: 'commits', base: f.base, head });
  await writeFile(join(f.state, 'blobs', s.manifest.head['app.py'].hash), 'tamper'); await assert.rejects(s.text('head', 'app.py'), /integrity/);
  const path = join(f.state, 'snapshots', s.manifest.identity.id + '.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.changedPaths = [];
  await writeFile(path, JSON.stringify(manifest)); await assert.rejects(SnapshotStore.load(f.state, manifest.identity.id), /coverage/);
});

test('state isolation and atomic replacement fail closed', async t => {
  const f = await repositoryFixture(t); await assert.rejects(isolatedState(join(f.repository, 'state'), f.repository), /outside/);
  await assert.rejects(isolatedState(f.directory, f.repository), /outside/);
  const target = join(f.state, 'report'); await mkdir(target); await assert.rejects(atomicWrite(target, 'new report'));
  assert.deepEqual(await readdir(f.state), ['report']);
});

test('UTF-8 BOM and CRLF bytes remain exact in immutable blobs', async t => {
  const f = await repositoryFixture(t, { 'app.py': '\ufeffprint("ok")\r\n' });
  const s = await freeze(f, { kind:'commits', base:f.base, head:f.base });
  assert.equal(await s.text('head','app.py'), '\ufeffprint("ok")\r\n');
  assert.equal(s.manifest.head['app.py'].hash,sha256('\ufeffprint("ok")\r\n'));
});

test('staged additions in an unborn repository use an empty base rather than a fake commit', async t => {
  const f=await repositoryFixture(t); await f.git('checkout','--orphan','new-root');
  const s=await freeze(f,{kind:'staged'});
  assert.equal(s.manifest.identity.baseCommit,undefined); assert.equal(s.manifest.identity.baseVersion.kind,'empty');
  assert.deepEqual(s.manifest.changedPaths,['app.py']);
});
