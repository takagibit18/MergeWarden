import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../src/infrastructure/files.ts';
import { repositoryFixture } from './repository-fixture.mjs';

test('atomic replacement preserves complete JSON while concurrent readers poll it', { timeout: 30_000 }, async t => {
  const f = await repositoryFixture(t), target = join(f.state, 'run.json');
  const payload = 'immutable report metadata '.repeat(100);
  await atomicWrite(target, JSON.stringify({ version: 0, payload }));
  let stopping = false, reads = 0;
  const reader = (async () => {
    while (!stopping) {
      const value = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(value.payload, payload);
      assert.ok(Number.isInteger(value.version) && value.version >= 0 && value.version <= 100);
      reads++;
    }
  })();
  void reader.catch(() => undefined);
  try { for (let version = 1; version <= 100; version++) await atomicWrite(target, JSON.stringify({ version, payload })); }
  finally { stopping = true; await reader; }
  assert.ok(reads > 0); assert.equal(JSON.parse(await readFile(target, 'utf8')).version, 100);
  assert.deepEqual(await readdir(f.state), ['run.json']);
});

test('a permanent replacement failure stays bounded and preserves the destination', { timeout: 10_000 }, async t => {
  const f = await repositoryFixture(t), target = join(f.state, 'run.json');
  await mkdir(target); await writeFile(join(target, 'keep'), 'existing state');
  const started = Date.now();
  await assert.rejects(atomicWrite(target, 'cannot replace a directory'));
  assert.ok(Date.now() - started < 5_000);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'existing state');
  assert.deepEqual(await readdir(f.state), ['run.json']);
});
