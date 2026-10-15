import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { WorkbenchError } from '../src/application/workbench/index.ts';
import { openWorkbench } from '../src/composition/workbench.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { ReviewEngine } from '../src/engine/review.ts';
import { deliver, readReport, readRun, runPath } from '../src/engine/reports.ts';
import { WorkbenchDatabase } from '../src/infrastructure/workbench-db/database.ts';
import { HistoryProjection } from '../src/infrastructure/workbench-db/history-projection.ts';
import { ProjectRegistry } from '../src/infrastructure/workbench-db/project-registry.ts';
import { migrateWorkbenchDatabase, WORKBENCH_SCHEMA_VERSION } from '../src/infrastructure/workbench-db/migrations.ts';
import { repositoryDirectory } from '../src/infrastructure/workbench-fs/git-registration.ts';
import { sha256, writeJson } from '../src/infrastructure/files.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { repositoryFixture } from './repository-fixture.mjs';

const model = { provider: 'fixture', modelId: 'offline' };
function runtime(script) {
  return async options => ({ journal: new MemoryJournal(),
    async prompt(_text, signal) { await script(Object.fromEntries(options.tools.map(tool => [tool.name, tool.execute])), signal); },
    async abort() {}, dispose() {}, usage: () => ({ input: 10, output: 5, total: 15 }) });
}
async function submit(tools) {
  await tools.read_diff({ path: 'app.py' });
  const source = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
  await tools.submit_review({ summary: 'Offline native storage fixture.', reviewedPaths: ['app.py'], findings: [{
    id: 'division', title: 'Zero division', claim: 'Zero count raises.', trigger: 'count=0', impact: 'request fails', severity: 'high',
    evidence: [{ evidenceRefId: source._mergewarden.evidenceRefId }],
  }] });
}
async function fixture(t) {
  const cleanup = [], services = [];
  t.after(async () => { try { for (const service of services) await service.close(); } finally { for (const remove of cleanup) await remove(); } });
  const f = await repositoryFixture({ after: remove => cleanup.push(remove) });
  const head = await f.change();
  const options = { repositoryPath: f.repository, stateDir: f.state, model, skills: 'off', learn: 'off', input: { kind: 'commits', base: f.base, head } };
  return { ...f, options,
    async review(script = submit, overrides = {}) { return new ReviewEngine(runtime(script)).run({ ...options, ...overrides }); },
    async service(overrides = {}) { const service = await openWorkbench({ repositoryPath: f.repository, stateDir: f.state, ...overrides }); services.push(service); return service; },
    track(service) { services.push(service); return service; } };
}
async function copyRun(f, originalId, overrides = {}) {
  const previous = await readRun(f.state, originalId);
  const original = await readReport(f.state, originalId);
  const id = randomUUID();
  const status = overrides.outcome ?? original.status;
  const manifest = { ...previous, runId: id, createdAt: overrides.createdAt ?? previous.createdAt,
    termination: { reason: status === 'completed' ? 'completed' : 'incomplete', finalSubmission: status === 'completed' }, ...overrides };
  await deliver(f.state, manifest, { ...original, runId: id, status });
  return id;
}
async function receipt(f, fields = {}) {
  const taskId = fields.taskId ?? randomUUID();
  const value = { schemaVersion: 1, taskId, repositoryPath: f.repository, createdAt: new Date().toISOString(),
    requestSha256: sha256('fixture request'), owner: { id: randomUUID(), pid: process.pid }, ...fields };
  await writeJson(join(f.state, 'mcp', 'tasks', taskId, 'task.json'), value);
  return taskId;
}
async function fullSweep(service) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = await service.listReviews(service.defaultProjectId, { limit: 50 });
    if (!page.sync.truncated) return page;
  }
  throw new Error('Bounded native scan did not finish');
}
function errorCode(code, statusCode) {
  return error => error instanceof WorkbenchError && error.code === code && (statusCode === undefined || error.statusCode === statusCode);
}

test('workbench projects real native delivery and reads unchanged frozen evidence after worktree edits', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  const run = await readRun(f.state, result.runId);
  await writeJson(join(runPath(f.state, result.runId), 'run.json'), { ...run,
    runtimeConfiguration: { authentication: { type: 'oauth', secret: 'credential-must-not-leak' } }, secret: 'private-manifest-field' });
  const page = await fullSweep(service);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].status, 'completed');
  assert.equal(page.items[0].findingCount, 1);
  assert.equal(page.items[0].reportAvailability, 'verified');
  assert.doesNotMatch(JSON.stringify(page), /credential-must-not-leak|private-manifest-field|runtimeConfiguration/);
  assert.deepEqual((await service.report(service.defaultProjectId, result.runId)).report, result.report);
  await f.write('app.py', 'worktree contents changed\n');
  const evidence = await service.evidence(service.defaultProjectId, result.runId, 'division');
  assert.equal(evidence.source.text, 'def ratio(total, count):\n    return total / count');
  assert.equal(evidence.source.contentSha256, result.report.findings[0].evidence[0].contentSha256);
  assert.equal((await service.task(service.defaultProjectId, result.runId)).canCancel, false);
  assert.equal((await service.task(service.defaultProjectId, result.runId)).done, true);
});

test('workbench public reports drop unexpected report and nested reference fields', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  const report = structuredClone(result.report);
  report.secret = 'untrusted-extra-report'; report.snapshot.secret = 'untrusted-extra-snapshot';
  report.findings[0].secret = 'untrusted-extra-finding'; report.findings[0].evidence[0].secret = 'untrusted-extra-evidence';
  await deliver(f.state, await readRun(f.state, result.runId), report);
  const output = await service.report(service.defaultProjectId, result.runId);
  assert.deepEqual(output.report, result.report);
  assert.doesNotMatch(JSON.stringify(output), /untrusted-extra/);
});

test('SQLite projection persists across restart with versioned DELETE/FULL and foreign keys', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  await fullSweep(service); await service.close();
  const path = join(f.state, 'workbench.sqlite');
  const database = new DatabaseSync(path);
  migrateWorkbenchDatabase(database);
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, WORKBENCH_SCHEMA_VERSION);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(database.prepare('SELECT count(*) AS n FROM history_entries').get().n, 1);
  assert.equal(database.prepare('SELECT history_id FROM history_entries').get().history_id, result.runId);
  assert.throws(() => database.prepare(`INSERT INTO history_entries(repository_id,source_kind,source_id,history_id,created_at,status,scope,delivery_verified,item_json,item_sha256,seen_epoch,seen_at,project_id)
    SELECT 'missing-repository',source_kind,source_id,history_id,created_at,status,scope,delivery_verified,item_json,item_sha256,seen_epoch,seen_at,project_id FROM history_entries`).run(), /FOREIGN KEY/);
  database.close();
  const reopened = await f.service();
  assert.equal((await fullSweep(reopened)).items[0].runId, result.runId);
});

test('history normalizes legacy ISO timestamps and keyset pages ties without duplicates', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  const ids = [result.runId];
  for (let index = 0; index < 5; index++) ids.push(await copyRun(f, result.runId, { createdAt: '2026-10-01T07:20:00.53Z', outcome: index === 4 ? 'partial' : 'completed' }));
  const manifest = await readRun(f.state, result.runId);
  await writeJson(join(runPath(f.state, result.runId), 'run.json'), { ...manifest, createdAt: '2026-10-01T07:20:00.77Z', finishedAt: '2026-10-01T07:20:01Z' });
  const page = await fullSweep(service);
  assert.equal(page.items[0].createdAt, '2026-10-01T07:20:00.770Z');
  assert.equal(page.items[0].finishedAt, '2026-10-01T07:20:01.000Z');
  const found = [];
  let cursor;
  do {
    const page = await service.listReviews(service.defaultProjectId, { status: 'completed', scope: 'commits', limit: 2, ...(cursor ? { cursor } : {}) });
    found.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(found.length, 5); assert.equal(new Set(found).size, 5);
  assert.equal((await service.listReviews(service.defaultProjectId, { status: 'partial' })).items.length, 1);
  assert.equal((await service.listReviews(service.defaultProjectId, { scope: 'staged' })).items.length, 0);
  const first = await service.listReviews(service.defaultProjectId, { status: 'completed', limit: 1 });
  await assert.rejects(service.listReviews(service.defaultProjectId, { status: 'partial', cursor: first.nextCursor }), errorCode('INVALID_QUERY', 400));
  await assert.rejects(service.listReviews(service.defaultProjectId, { limit: 51 }), errorCode('INVALID_QUERY', 400));
  await assert.rejects(service.listReviews(service.defaultProjectId, { status: "completed' OR 1=1" }), errorCode('INVALID_QUERY', 400));
  await assert.rejects(service.listReviews(service.defaultProjectId, { cursor: 'not-a-valid-cursor' }), errorCode('INVALID_QUERY', 400));
  await assert.rejects(service.listReviews(service.defaultProjectId, { repositoryPath: f.repository }), errorCode('INVALID_QUERY', 400));
});

test('actual history SQL uses the order/filter and preferred-source indexes without a sort', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  await copyRun(f, result.runId); await fullSweep(service);
  const queries = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(sql) {
    if (sql.startsWith('SELECT e.item_json')) queries.push(sql);
    return prepare.call(this, sql);
  });
  await service.listReviews(service.defaultProjectId, { limit: 1 });
  await service.listReviews(service.defaultProjectId, { status: 'completed', scope: 'commits', limit: 1 });
  const database = new DatabaseSync(join(f.state, 'workbench.sqlite'), { readOnly: true });
  const unfiltered = database.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all(sha256(f.repository), 2).map(row => row.detail).join('\n');
  const filtered = database.prepare(`EXPLAIN QUERY PLAN ${queries[1]}`).all(sha256(f.repository), 'completed', 'commits', 2).map(row => row.detail).join('\n');
  database.close();
  assert.match(unfiltered, /history_order/); assert.match(filtered, /history_status_scope/);
  assert.match(unfiltered, /history_preferred/); assert.match(filtered, /history_preferred/);
  assert.doesNotMatch(unfiltered + filtered, /TEMP B-TREE/);
});

test('shared-state repository filtering and cursors never include foreign review details or skipped failures', async t => {
  const f = await fixture(t), other = await fixture(t);
  const local = await f.review(); await copyRun(f, local.runId);
  const foreign = await other.review(submit, { stateDir: f.state });
  const service = await f.service(), foreignService = f.track(await openWorkbench({ repositoryPath: other.repository, stateDir: f.state }));
  const page = await fullSweep(service);
  assert.equal(page.items.length, 2); assert.equal(page.sync.skipped, 0);
  assert.ok(page.items.every(item => item.repositoryPath === f.repository && item.runId !== foreign.runId));
  await assert.rejects(service.report(service.defaultProjectId, foreign.runId), errorCode('REPOSITORY_MISMATCH', 404));
  await assert.rejects(service.evidence(service.defaultProjectId, foreign.runId, 'division'), errorCode('REPOSITORY_MISMATCH', 404));
  await assert.rejects(service.task(service.defaultProjectId, foreign.runId), errorCode('NOT_FOUND', 404));
  const cursor = (await service.listReviews(service.defaultProjectId, { limit: 1 })).nextCursor;
  await assert.rejects(foreignService.listReviews(foreignService.defaultProjectId, { cursor }), errorCode('INVALID_QUERY', 400));
  const taskId = await receipt(f, { runId: foreign.runId });
  const task = await service.task(service.defaultProjectId, taskId);
  assert.equal(task.item.status, null); assert.equal(task.item.reportAvailability, 'unavailable');
  assert.equal(task.item.model, undefined); assert.equal(task.item.snapshotId, undefined); assert.equal(task.item.findingCount, undefined);
});

test('native JSON/Markdown corruption invalidates cached success and details reverify every read', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  await fullSweep(service);
  await writeFile(result.markdownPath, 'tampered private-report-payload');
  await assert.rejects(service.report(service.defaultProjectId, result.runId), errorCode('REPORT_INTEGRITY', 409));
  await assert.rejects(service.evidence(service.defaultProjectId, result.runId, 'division'), errorCode('REPORT_INTEGRITY', 409));
  const page = await fullSweep(service);
  assert.equal(page.items[0].status, null); assert.equal(page.items[0].reportAvailability, 'unavailable');
  assert.equal(page.items[0].findingCount, undefined); assert.equal(page.sync.skipped, 1);
  assert.doesNotMatch(JSON.stringify(page), /private-report-payload/);
  await writeFile(join(runPath(f.state, result.runId), 'run.json'), '{invalid manifest');
  const damaged = await fullSweep(service);
  assert.equal(damaged.items[0].status, null); assert.equal(damaged.items[0].runId, result.runId);
  assert.equal(damaged.items[0].findingCount, undefined);
});

test('snapshot tampering and mismatched completed coverage cannot pass valid delivery hashes', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  const invalid = structuredClone(result.report); invalid.coverage['app.py'] = 'pending';
  await deliver(f.state, await readRun(f.state, result.runId), invalid);
  await assert.rejects(service.report(service.defaultProjectId, result.runId), errorCode('REPORT_INTEGRITY', 409));
  assert.equal((await fullSweep(service)).items[0].status, null);
  await deliver(f.state, await readRun(f.state, result.runId), result.report);
  const path = join(f.state, 'snapshots', result.report.snapshot.id + '.json');
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  await writeJson(path, { ...snapshot, repositoryPath: f.repository + '-foreign' });
  await assert.rejects(service.report(service.defaultProjectId, result.runId), errorCode('REPORT_INTEGRITY', 409));
  assert.equal((await fullSweep(service)).items[0].reportAvailability, 'unavailable');
});

test('evidence selection and frozen blob integrity use the native source checks', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  await assert.rejects(service.evidence(service.defaultProjectId, result.runId, 'unknown'), errorCode('NOT_FOUND', 404));
  await assert.rejects(service.evidence(service.defaultProjectId, result.runId, 'division', 1), errorCode('NOT_FOUND', 404));
  await assert.rejects(service.evidence(service.defaultProjectId, result.runId, 'division', -1), errorCode('INVALID_QUERY', 400));
  const snapshot = await SnapshotStore.load(f.state, result.report.snapshot.id);
  await writeFile(join(f.state, 'blobs', snapshot.manifest.head['app.py'].hash), 'corrupted-frozen-source');
  await assert.rejects(service.evidence(service.defaultProjectId, result.runId, 'division'), errorCode('EVIDENCE_INTEGRITY', 409));
});

test('task projection handles no-run no_changes and never invents completion from receipts or running manifests', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service();
  const snapshot = await SnapshotStore.freeze({ repositoryPath: f.repository, stateDir: f.state,
    input: { kind: 'commits', base: f.base, head: f.base }, configuration: { fixture: true } });
  const done = new Date().toISOString();
  const unchanged = await receipt(f, { finishedAt: done, noChanges: { snapshotId: snapshot.manifest.identity.id } });
  const failed = await receipt(f, { finishedAt: done, failure: 'failed' });
  const cancelled = await receipt(f, { finishedAt: done, failure: 'cancelled' });
  const accepted = await receipt(f);
  const interrupted = await receipt(f, { owner: { id: randomUUID(), pid: 2147483647 } });
  const invalid = await receipt(f, { finishedAt: done, noChanges: { snapshotId: result.report.snapshot.id } });
  assert.equal((await service.task(service.defaultProjectId, unchanged)).item.status, 'no_changes');
  assert.equal((await service.task(service.defaultProjectId, unchanged)).item.runId, undefined);
  assert.equal((await service.task(service.defaultProjectId, unchanged)).item.reportAvailability, 'not_delivered');
  assert.equal((await service.task(service.defaultProjectId, failed)).item.status, 'failed');
  assert.equal((await service.task(service.defaultProjectId, cancelled)).item.status, 'cancelled');
  assert.equal((await service.task(service.defaultProjectId, accepted)).item.status, 'accepted');
  assert.equal((await service.task(service.defaultProjectId, accepted)).done, false);
  assert.equal((await service.task(service.defaultProjectId, interrupted)).item.status, 'interrupted');
  assert.equal((await service.task(service.defaultProjectId, invalid)).item.status, null);
  const manifest = await readRun(f.state, result.runId), runningId = randomUUID();
  await writeJson(join(runPath(f.state, runningId), 'run.json'), { ...manifest, runId: runningId, status: 'running' });
  const running = await service.task(service.defaultProjectId, runningId);
  assert.equal(running.item.status, 'running'); assert.equal(running.item.liveness, 'unknown'); assert.equal(running.done, false);
  await assert.rejects(service.report(service.defaultProjectId, runningId), errorCode('NOT_DELIVERED', 409));
  const linked = await receipt(f, { runId: result.runId, finishedAt: done, failure: 'failed' });
  const page = await fullSweep(service);
  const native = page.items.filter(item => item.runId === result.runId);
  assert.equal(native.length, 1); assert.equal(native[0].id, result.runId); assert.equal(native[0].taskId, linked); assert.equal(native[0].status, 'completed');
});

test('partial native delivery after agent end remains partial with zero findings', async t => {
  const f = await fixture(t), result = await f.review(async () => {}), service = await f.service();
  assert.equal(result.report.status, 'partial');
  const item = (await fullSweep(service)).items[0];
  assert.equal(item.status, 'partial'); assert.equal(item.findingCount, 0);
  assert.equal((await service.report(service.defaultProjectId, result.runId)).report.status, 'partial');
});

test('bounded sync advances, survives restart and removes disappeared native sources after a full sweep', async t => {
  const f = await fixture(t), result = await f.review();
  const manifest = await readRun(f.state, result.runId), ids = [result.runId];
  for (let index = 0; index < 16; index++) {
    const id = randomUUID(); ids.push(id);
    await writeJson(join(runPath(f.state, id), 'run.json'), { ...manifest, runId: id, status: 'running' });
  }
  const first = await f.service({ syncBatchSize: 3 });
  const batch = await first.listReviews(first.defaultProjectId);
  assert.ok(batch.sync.scanned <= 3); assert.equal(batch.sync.truncated, true); assert.ok(batch.items.length <= 3);
  await first.close();
  const restarted = await f.service({ syncBatchSize: 3 });
  const page = await fullSweep(restarted);
  assert.equal(page.items.length, ids.length);
  assert.deepEqual(new Set(page.items.map(item => item.id)), new Set(ids));
  await rm(runPath(f.state, ids[0]), { recursive: true, force: true });
  const after = await fullSweep(restarted);
  assert.equal(after.items.length, ids.length - 1); assert.ok(after.items.every(item => item.id !== ids[0]));
});

test('projection keeps verified summary titles and drops stored fallback titles', async t => {
  const f = await fixture(t), database = new WorkbenchDatabase(join(f.state, 'titles.sqlite'));
  const directory = await repositoryDirectory(f.repository), createdAt = new Date().toISOString();
  const project = new ProjectRegistry(database).registerProject({ ...directory, name: 'Fixture', registeredAt: createdAt });
  const projection = new HistoryProjection(database);
  const item = id => ({ id, runId: id, repositoryPath: f.repository, createdAt, status: 'running', scope: 'commits', reportAvailability: 'not_delivered' });
  const summary = randomUUID(), legacy = randomUUID();
  projection.apply(project, [
    { kind: 'run', sourceId: summary, epoch: 'fixture', item: { ...item(summary), title: 'Verified summary line' } },
    { kind: 'run', sourceId: legacy, epoch: 'fixture', item: { ...item(legacy), title: '提交审查 · 2026-10-11 08:00 UTC', titleSource: 'fallback' } },
  ], [], createdAt);
  const titles = new Map(projection.list(project, { limit: 20 }).items.map(entry => [entry.id, entry]));
  assert.equal(titles.get(summary)?.title, 'Verified summary line');
  assert.equal('title' in titles.get(legacy), false);
  assert.equal('titleSource' in titles.get(summary), false);
  database.close();
});

test('projection failures roll back batches, reject future schemas and do not reset corrupt storage', async t => {
  const f = await fixture(t), path = join(f.state, 'transaction.sqlite');
  const database = new WorkbenchDatabase(path), projection = new HistoryProjection(database);
  const id = randomUUID(), createdAt = new Date().toISOString();
  const directory = await repositoryDirectory(f.repository);
  const project = new ProjectRegistry(database).registerProject({ ...directory, name: 'Fixture', registeredAt: createdAt });
  const item = { id, runId: id, repositoryPath: f.repository, createdAt, status: 'running', scope: 'commits', reportAvailability: 'not_delivered' };
  assert.throws(() => projection.apply(project, [
    { kind: 'run', sourceId: id, epoch: 'fixture', item },
    { kind: 'run', sourceId: randomUUID(), epoch: 'fixture', item: { ...item, repositoryPath: f.repository + '-other' } },
  ], [], createdAt), /membership mismatch/);
  assert.equal(projection.list(project, { limit: 20 }).items.length, 0); assert.equal(projection.lastSyncedAt(project), null); database.close();
  const memory = new DatabaseSync(':memory:');
  memory.exec('CREATE TABLE history_entries(dummy TEXT)');
  assert.throws(() => migrateWorkbenchDatabase(memory), /already exists/);
  assert.equal(memory.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='repositories'").get().n, 0);
  assert.equal(memory.prepare('PRAGMA user_version').get().user_version, 0);
  memory.exec('PRAGMA user_version=99');
  assert.throws(() => migrateWorkbenchDatabase(memory), /Unsupported/); memory.close();
  await writeFile(join(f.state, 'workbench.sqlite'), 'corrupt-private-storage-data');
  await assert.rejects(f.service(), errorCode('STORAGE_UNAVAILABLE', 503));
  assert.equal(await readFile(join(f.state, 'workbench.sqlite'), 'utf8'), 'corrupt-private-storage-data');
});

test('schema v2 upgrades to the current version and keeps history after explicit project registration', async t => {
  const f = await fixture(t), path = join(f.state, 'upgrade.sqlite'), id = randomUUID(), createdAt = new Date().toISOString();
  const item = { id, runId: id, repositoryPath: f.repository, createdAt, status: 'running', scope: 'commits', reportAvailability: 'not_delivered' };
  const original = new WorkbenchDatabase(path);
  const directory = await repositoryDirectory(f.repository);
  const legacyProject = new ProjectRegistry(original).registerProject({ ...directory, name: 'Fixture', registeredAt: createdAt });
  new HistoryProjection(original).apply(legacyProject, [{ kind: 'run', sourceId: id, epoch: 'legacy', item }], [], createdAt); original.close();
  const old = new DatabaseSync(path);
  const legacyItem = JSON.parse(old.prepare('SELECT item_json FROM history_entries').get().item_json);
  delete legacyItem.projectId; delete legacyItem.workspaceId;
  const legacyJson = JSON.stringify(legacyItem);
  old.prepare('UPDATE history_entries SET item_json=?,item_sha256=?,project_id=NULL').run(legacyJson, sha256(legacyJson));
  old.exec(`UPDATE history_entries SET project_id=NULL;
    DROP INDEX history_order; DROP INDEX history_status; DROP INDEX history_scope; DROP INDEX history_status_scope;
    DROP INDEX history_preferred; DROP INDEX history_observed; DROP INDEX history_workspace_order;
    DROP INDEX history_workspace_status; DROP INDEX history_workspace_scope; DROP INDEX history_workspace_status_scope;
    DROP TABLE project_workspaces; DROP TABLE projects; ALTER TABLE history_entries DROP COLUMN project_id;
    ALTER TABLE history_entries DROP COLUMN seen_at;
    CREATE INDEX history_order ON history_entries(repository_id,created_at DESC,history_id DESC);
    CREATE INDEX history_status ON history_entries(repository_id,status,created_at DESC,history_id DESC);
    CREATE INDEX history_scope ON history_entries(repository_id,scope,created_at DESC,history_id DESC);
    CREATE INDEX history_status_scope ON history_entries(repository_id,status,scope,created_at DESC,history_id DESC);
    CREATE INDEX history_preferred ON history_entries(repository_id,history_id,delivery_verified DESC,source_kind DESC,source_id DESC);
    CREATE INDEX history_sources ON history_entries(repository_id,source_kind,seen_epoch); PRAGMA user_version=2;`);
  old.close();
  const upgraded = new WorkbenchDatabase(path), registry = new ProjectRegistry(upgraded), projection = new HistoryProjection(upgraded);
  assert.equal(registry.projects().length, 0);
  const project = registry.registerProject({ ...directory, name: 'Fixture', registeredAt: createdAt });
  projection.adopt(project);
  const migratedItems = projection.list(project, { limit: 20 }).items;
  assert.equal(migratedItems.length, 1); assert.equal(migratedItems[0]?.runId, id);
  assert.equal(migratedItems[0]?.projectId, project.id);
  assert.equal(projection.lastSyncedAt(project), createdAt); upgraded.close();
  const verified = new DatabaseSync(path, { readOnly: true });
  assert.equal(verified.prepare('PRAGMA user_version').get().user_version, WORKBENCH_SCHEMA_VERSION);
  assert.equal(verified.prepare('SELECT seen_at FROM history_entries').get().seen_at, ''); verified.close();
});

test('two independent SQLite connections can race initial migrations safely', async t => {
  const f = await fixture(t), barrier = new SharedArrayBuffer(8), state = new Int32Array(barrier);
  const workers = [];
  const migrationModule = new URL('../src/infrastructure/workbench-db/migrations.ts', import.meta.url).href;
  const completed = [];
  const ready = [];
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(`
      (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const { parentPort, workerData } = await import('node:worker_threads');
      const { migrateWorkbenchDatabase } = await import(workerData.migrationModule);
      const database = new DatabaseSync(workerData.path);
      const state = new Int32Array(workerData.barrier);
      parentPort.postMessage('ready');
      Atomics.wait(state, 1, 0, 10000);
      migrateWorkbenchDatabase(database); database.close();
      parentPort.postMessage('done');
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { path: join(f.state, 'racing.sqlite'), barrier, migrationModule } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message === 'ready') resolve(); }); worker.on('error', reject); }));
    completed.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message === 'done') resolve(); }); worker.on('error', reject); }));
  }
  t.after(async () => { for (const worker of workers) await worker.terminate(); });
  await Promise.all(ready); Atomics.store(state, 1, 1); Atomics.notify(state, 1, 2); await Promise.all(completed);
  const database = new DatabaseSync(join(f.state, 'racing.sqlite'), { readOnly: true });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, WORKBENCH_SCHEMA_VERSION);
  assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok'); database.close();
});

test('interleaved service scanners preserve observations from another completed sweep', async t => {
  const f = await fixture(t), result = await f.review();
  const manifest = await readRun(f.state, result.runId), ids = [result.runId];
  for (let index = 0; index < 3; index++) {
    const id = randomUUID(); ids.push(id);
    await writeJson(join(runPath(f.state, id), 'run.json'), { ...manifest, runId: id, status: 'running' });
  }
  const first = await f.service({ syncBatchSize: 2 }), second = await f.service({ syncBatchSize: 2 });
  await first.listReviews(first.defaultProjectId); await second.listReviews(second.defaultProjectId);
  await first.listReviews(first.defaultProjectId); await second.listReviews(second.defaultProjectId);
  const completed = await fullSweep(first);
  assert.equal(completed.items.length, ids.length);
  assert.deepEqual(new Set(completed.items.map(item => item.id)), new Set(ids));
  assert.equal((await fullSweep(second)).items.length, ids.length);
});

test('concurrent history reads serialize bounded sync and service close is idempotent', async t => {
  const f = await fixture(t), result = await f.review(), service = await f.service({ syncBatchSize: 1 });
  const pages = await Promise.all(Array.from({ length: 6 }, () => service.listReviews(service.defaultProjectId)));
  assert.ok(pages.every(page => page.sync.scanned <= 1));
  assert.equal(pages.at(-1).items[0].runId, result.runId);
  await service.close(); await service.close();
  await assert.rejects(service.listReviews(service.defaultProjectId), errorCode('STORAGE_UNAVAILABLE', 503));
  await assert.rejects(service.report(service.defaultProjectId, result.runId), errorCode('STORAGE_UNAVAILABLE', 503));
});
