import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectsResponseSchema, projectRegistrationSchema, workspaceRegistrationSchema,
  historyQuerySchema, evidenceDiffResponseSchema, diffQuerySchema,
} from '../dist/index.js';

const projectId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const hash = 'a'.repeat(64);
const catalog = () => ({
  defaultProjectId: projectId,
  projects: [{ id: projectId, name: 'Requests', repositoryPath: '/repos/requests', createdAt: '2026-10-11T00:00:00.000Z',
    workspaces: [{ id: hash, name: 'requests', path: '/repos/requests', kind: 'primary', registeredAt: '2026-10-11T00:00:00.000Z' }] }],
});

test('catalog rejects ambiguous project and workspace membership', () => {
  assert.equal(projectsResponseSchema.safeParse(catalog()).success, true);
  for (const mutate of [
    value => { value.defaultProjectId = runId; },
    value => { value.projects.push(structuredClone(value.projects[0])); },
    value => { value.projects[0].workspaces[0].kind = 'worktree'; },
    value => { value.projects[0].repositoryPath = '/different'; },
    value => { value.projects[0].workspaces.push({ ...value.projects[0].workspaces[0], kind: 'worktree', path: '/worktrees/requests' }); },
    value => { value.projects.push({ ...structuredClone(value.projects[0]), id: runId }); },
  ]) {
    const value = catalog(); mutate(value);
    assert.equal(projectsResponseSchema.safeParse(value).success, false);
  }
});

test('directory registration accepts only bounded explicit metadata and histories reject raw paths', () => {
  assert.deepEqual(projectRegistrationSchema.parse({ name: ' Requests ', repositoryPath: ' /repos/requests ' }),
    { name: 'Requests', repositoryPath: '/repos/requests' });
  assert.equal(workspaceRegistrationSchema.safeParse({ repositoryPath: '/worktrees/requests' }).success, true);
  for (const value of [
    { name: '', repositoryPath: '/repo' }, { name: 'a\nb', repositoryPath: '/repo' },
    { repositoryPath: '/repo\u0000' }, { repositoryPath: '/repo', stateDir: '/private' },
    { repositoryPath: '/repo', projectId }, { repositoryPath: '/repo', name: 'a'.repeat(81) },
  ]) assert.equal(projectRegistrationSchema.safeParse(value).success, false);
  assert.equal(historyQuerySchema.safeParse({ workspaceId: hash }).success, true);
  for (const value of [{ workspaceId: '/repo' }, { workspaceId: '../repo' }, { projectId }, { repositoryPath: '/repo' }]) {
    assert.equal(historyQuerySchema.safeParse(value).success, false);
  }
});

const response = () => ({
  runId, findingId: 'credential-error', evidenceIndex: 0, evidenceCount: 1,
  evidence: { snapshotId: hash, revision: 'head', path: 'utils.py', startLine: 1, endLine: 1, contentSha256: hash },
  diff: {
    snapshotId: hash, path: 'utils.py', status: 'ok', changeType: 'modified',
    base: { exists: true, contentSha256: 'b'.repeat(64), totalLines: 1, endsWithNewline: true, mode: '100644' },
    head: { exists: true, contentSha256: 'c'.repeat(64), totalLines: 1, endsWithNewline: true, mode: '100644' },
    rows: [
      { kind: 'hunk', text: '@@ -1 +1 @@', baseLine: null, headLine: null, hunk: { baseStart: 1, baseCount: 1, headStart: 1, headCount: 1 } },
      { kind: 'deletion', text: 'old_value', baseLine: 1, headLine: null },
      { kind: 'addition', text: 'new_value', baseLine: null, headLine: 1 },
    ],
    offset: 0, totalRows: 3, nextOffset: null, truncated: false, warnings: [],
  },
});

test('diff envelope rejects mismatched evidence and impossible line provenance', () => {
  assert.equal(evidenceDiffResponseSchema.safeParse(response()).success, true);
  for (const mutate of [
    value => { value.diff.snapshotId = 'b'.repeat(64); },
    value => { value.diff.path = 'other.py'; },
    value => { value.evidenceIndex = 1; },
    value => { value.diff.rows[1].headLine = 1; },
    value => { value.diff.rows[2].headLine = null; },
    value => { value.diff.rows[0].baseLine = 1; },
    value => { value.diff.rows[0].hunk = undefined; },
  ]) {
    const value = response(); mutate(value);
    assert.equal(evidenceDiffResponseSchema.safeParse(value).success, false);
  }
});

test('diff pagination cannot loop, silently drop rows or claim unavailable data is a diff', () => {
  const first = response();
  first.diff.rows = first.diff.rows.slice(0, 2);
  first.diff.nextOffset = 2; first.diff.truncated = true;
  assert.equal(evidenceDiffResponseSchema.safeParse(first).success, true);
  for (const mutate of [
    value => { value.diff.nextOffset = 0; },
    value => { value.diff.nextOffset = 1; },
    value => { value.diff.truncated = false; },
    value => { value.diff.rows = []; value.diff.nextOffset = 0; },
    value => { value.diff.nextOffset = null; value.diff.truncated = false; },
    value => { value.diff.status = 'unavailable'; },
  ]) {
    const value = structuredClone(first); mutate(value);
    assert.equal(evidenceDiffResponseSchema.safeParse(value).success, false);
  }
  const unavailable = response();
  unavailable.diff = { ...unavailable.diff, status: 'unavailable', rows: [], totalRows: 0, warnings: ['Diff calculation exceeded its budget.'] };
  assert.equal(evidenceDiffResponseSchema.safeParse(unavailable).success, true);
  assert.deepEqual(diffQuerySchema.parse({}), { limit: 200 });
  for (const query of [{ limit: 201 }, { offset: -1 }, { offset: 'NaN' }, { path: '/private' }]) {
    assert.equal(diffQuerySchema.safeParse(query).success, false);
  }
});
