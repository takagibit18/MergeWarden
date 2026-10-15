import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkbenchServer } from '../src/server.ts';
import { buildEvidenceDiff } from '../../../src/application/evidence-diff.ts';

export const ORIGIN = 'http://127.0.0.1:4242';
export const HOST = new URL(ORIGIN).host;
export const RUN_ID = randomUUID();
export const PROJECT_ID = randomUUID();
const HASH = 'a'.repeat(64);
export const REF = { snapshotId: HASH, revision: 'head', path: 'app.py', startLine: 1, endLine: 2, contentSha256: HASH };
export const ITEM = {
  id: RUN_ID, runId: RUN_ID, repositoryPath: '/fixture/repository', createdAt: '2026-10-10T00:00:00.000Z',
  status: 'completed', scope: 'staged', reportAvailability: 'verified', findingCount: 1,
  model: { provider: 'fixture', modelId: 'offline' }, snapshotId: HASH,
};
export const PROJECT = { id: PROJECT_ID, name: 'Fixture project', repositoryPath: ITEM.repositoryPath, createdAt: ITEM.createdAt,
  workspaces: [{ id: HASH, path: ITEM.repositoryPath, name: 'repository', kind: 'primary', registeredAt: ITEM.createdAt }] };
export const REPORT = {
  review: ITEM, deliveryVerified: true, report: {
    schemaVersion: 1, runId: RUN_ID,
    snapshot: { id: HASH, repositoryId: 'fixture', inputFingerprint: HASH, configurationFingerprint: HASH },
    status: 'completed', summary: 'Synthetic HTTP transport fixture only.',
    findings: [{ id: 'division', title: 'Zero division', claim: 'Zero count raises.', trigger: 'count=0', impact: 'request fails', severity: 'high', evidence: [REF] }],
    coverage: { 'app.py': 'done' }, publication: 'not_requested',
  },
};
export function fakeService(overrides = {}) {
  return Object.assign({
    repositoryPath: ITEM.repositoryPath,
    async listProjects() { return { defaultProjectId: PROJECT_ID, projects: [PROJECT] }; },
    async registerProject() { return PROJECT; },
    async registerWorkspace() { return PROJECT; },
    async listReviews() { return { repositoryPath: ITEM.repositoryPath, items: [ITEM], nextCursor: null, sync: { lastSyncedAt: ITEM.createdAt, scanned: 1, skipped: 0, truncated: false } }; },
    async task() { return { item: ITEM, done: true, canCancel: false }; },
    async report() { return REPORT; },
    async evidence(_runId, findingId, index) {
      return { runId: RUN_ID, findingId, evidenceIndex: index, evidenceCount: 1, evidence: REF,
        source: { ...REF, status: 'ok', text: 'def ratio(total, count):\n    return total / count\n', totalLines: 2, truncated: false, warnings: [] } };
    },
    async evidenceDiff(_runId, findingId, index, query) {
      return { runId: RUN_ID, findingId, evidenceIndex: index, evidenceCount: 1, evidence: REF,
        diff: buildEvidenceDiff({ snapshotId: HASH, path: REF.path, before: 'def ratio(total, count):\n    return total / max(count, 1)\n',
          after: 'def ratio(total, count):\n    return total / count\n', baseMode: '100644', headMode: '100644' }, query) };
    },
    async close() {},
  }, overrides);
}
export async function assetsFixture(t) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'mergewarden-workbench-http-'));
  const assetsDir = join(directory, 'dist');
  await mkdir(join(assetsDir, 'assets'), { recursive: true });
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><html><head><title>Fixture</title><script type="module" src="/assets/app.js"></script></head><body>Compiled app fixture</body></html>');
  await writeFile(join(assetsDir, 'assets', 'app.js'), 'document.body.dataset.fixture = "loaded";');
  t.after(async () => { assert.ok(resolve(directory).startsWith(parent + sep)); await rm(directory, { recursive: true, force: true }); });
  return { directory, assetsDir };
}
export async function serverFixture(t, service = fakeService()) {
  let server;
  t.after(async () => { await server?.close(); });
  const assets = await assetsFixture(t);
  server = createWorkbenchServer({ service, assetsDir: assets.assetsDir, origin: ORIGIN });
  return { ...assets, server, app: server.app, service };
}
export async function authenticate(server, origin = ORIGIN) {
  const response = await server.app.inject({ method: 'POST', url: '/_workbench/session',
    headers: { host: new URL(origin).host, origin, 'content-type': 'application/json' }, payload: { token: server.launchToken } });
  assert.equal(response.statusCode, 204, response.body);
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}
export const get = (app, url, cookie, extra = {}) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...extra } });
export const assertError = (response, status, code) => {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.match(response.json().error.traceId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers['cache-control'], 'no-store');
};
