import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryDirectory } from '../src/infrastructure/workbench-fs/git-registration.ts';
import { repositoryFixture } from './repository-fixture.mjs';

test('explicit directory registration resolves canonical Git roots and shared worktree identity', async t => {
  const fixture = await repositoryFixture(t);
  const worktree = join(fixture.directory, 'worktree');
  await fixture.git('worktree', 'add', '--detach', worktree, fixture.base);
  const main = await repositoryDirectory(fixture.repository);
  const linked = await repositoryDirectory(worktree);
  assert.equal(main.repositoryPath, await realpath(fixture.repository));
  assert.equal(linked.repositoryPath, await realpath(worktree));
  assert.equal(linked.commonGitDirectory, main.commonGitDirectory);
  const other = await repositoryFixture(t);
  assert.notEqual((await repositoryDirectory(other.repository)).commonGitDirectory, main.commonGitDirectory);
  await assert.rejects(repositoryDirectory(fixture.directory), /Git .* failed/);
  await assert.rejects(repositoryDirectory(join(fixture.repository, 'app.py')), /root directory/);
  await assert.rejects(repositoryDirectory('invalid\0directory'), /root directory/);
});
