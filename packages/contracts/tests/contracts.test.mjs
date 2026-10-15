import assert from 'node:assert/strict';
import test from 'node:test';
import { historyQuerySchema, configResponseSchema, taskResponseSchema, reportResponseSchema } from '../dist/index.js';

test('history accepts bounded filters and rejects undeclared host configuration', () => {
  assert.deepEqual(historyQuerySchema.parse({ status: 'completed', scope: 'commits', limit: '20' }), { status: 'completed', scope: 'commits', limit: 20 });
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 'NaN' }, { status: 'delivered' }, { repositoryPath: '/other' }, { cursor: '' }]) {
    assert.equal(historyQuerySchema.safeParse(query).success, false);
  }
});

test('M1 contract does not permit review execution or cancellation', () => {
  const config = {
    apiVersion: 'v1', repository: { path: '/repo', name: 'repo' },
    capabilities: { readHistory: true, readReport: true, readEvidence: true, startReview: false, cancelReview: false, feedback: false, learning: false },
    history: { defaultLimit: 20, maxLimit: 50 },
  };
  assert.equal(configResponseSchema.safeParse(config).success, true);
  assert.equal(configResponseSchema.safeParse({ ...config, capabilities: { ...config.capabilities, startReview: true } }).success, false);
  const runId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', hash = 'a'.repeat(64);
  const item = { id: runId, runId, repositoryPath: '/repo', createdAt: '2026-10-11T00:00:00.000Z',
    status: 'completed', scope: 'commits', snapshotId: hash, findingCount: 0, reportAvailability: 'verified' };
  const task = { item, done: true, canCancel: false };
  assert.equal(taskResponseSchema.safeParse(task).success, true);
  assert.equal(taskResponseSchema.safeParse({ ...task, canCancel: true }).success, false);
  const response = { deliveryVerified: true, review: item, report: {
    schemaVersion: 1, runId, snapshot: { id: hash, repositoryId: hash,
      inputFingerprint: hash, configurationFingerprint: hash, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) },
    status: 'completed', summary: 'No findings in this fixture.', findings: [], coverage: { 'a.py': 'done' }, publication: 'not_requested',
  } };
  assert.equal(reportResponseSchema.safeParse(response).success, true);
  assert.equal(reportResponseSchema.safeParse({ ...response, deliveryVerified: false }).success, false);
  assert.equal(reportResponseSchema.safeParse({ ...response, review: { ...item, runtimeConfiguration: { provider: 'private' } } }).success, false);
});
