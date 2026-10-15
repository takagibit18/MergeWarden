import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryDirectory } from '../src/infrastructure/workbench-fs/git-registration.ts';
import { WorkbenchDatabase } from '../src/infrastructure/workbench-db/database.ts';
import { ProjectRegistry } from '../src/infrastructure/workbench-db/project-registry.ts';
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

test('registering a linked worktree as a project joins the project that owns its Git common directory', async t => {
  const fixture = await repositoryFixture(t);
  const worktree = join(fixture.directory, 'worktree');
  await fixture.git('worktree', 'add', '--detach', worktree, fixture.base);
  const database = new WorkbenchDatabase(join(fixture.state, 'registry.sqlite'));
  try {
    const registry = new ProjectRegistry(database), registeredAt = new Date().toISOString();
    const main = registry.registerProject({ ...await repositoryDirectory(fixture.repository), name: 'Main', registeredAt });
    const joined = registry.registerProject({ ...await repositoryDirectory(worktree), name: 'Linked', registeredAt });
    assert.equal(joined.id, main.id);
    assert.equal(registry.projects().length, 1);
    assert.deepEqual(joined.workspaces.map(workspace => [workspace.name, workspace.kind]), [['Main', 'primary'], ['Linked', 'worktree']]);
    assert.equal(registry.registerWorkspace(main.id, { ...await repositoryDirectory(worktree), name: 'Again', registeredAt }).workspaces.length, 2);
    const other = await repositoryFixture(t);
    assert.notEqual(registry.registerProject({ ...await repositoryDirectory(other.repository), name: 'Other', registeredAt }).id, main.id);
  } finally { database.close(); }
});
