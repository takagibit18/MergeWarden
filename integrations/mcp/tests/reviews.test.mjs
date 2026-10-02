import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readReport } from '../../../src/engine/reports.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { SnapshotStore } from '../../../src/snapshot/store.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { ReviewTasks } from '../src/reviews.ts';
import { assertStatus, connected, fixture, reviewing, scriptedRuntime, submitFinding, terminal } from './helpers.mjs';

for (const era of ['legacy', 'modern']) test(`${era} MCP: async start -> original report -> frozen evidence -> history`, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, scriptedRuntime(async tools => { await gate; await submitFinding(tools); }));
  const { call, client } = await connected(t, f.tasks, era);
  assert.equal(client.getProtocolEra(), era);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), ['cancel_review', 'get_review', 'list_reviews', 'read_evidence', 'start_review']);
  assert.equal(catalog.tools.find(tool => tool.name === 'start_review').annotations.readOnlyHint, false);
  assert.equal(catalog.tools.find(tool => tool.name === 'read_evidence').annotations.readOnlyHint, true);
  const before = await f.git('status', '--porcelain');
  const started = await call('start_review', {}, { timeout: 1000 });
  assert.equal(started.isError, undefined);
  const { taskId } = started.structuredContent; assert.ok(taskId);
  const running = await reviewing(f.tasks, taskId);
  assert.equal(running.done, false); assert.equal(running.canCancel, true);
  release(); const done = await terminal(f.tasks, taskId);
  await assertStatus(f, done, 'completed'); assert.deepEqual(done.report, await readReport(f.state, done.runId));
  const fetched = await call('get_review', { id: taskId }); assert.deepEqual(fetched.structuredContent.report, done.report);
  assert.deepEqual(JSON.parse(fetched.content[0].text), fetched.structuredContent);
  const light = (await call('get_review', { id: done.runId, includeReport: false })).structuredContent;
  assert.equal(light.status, 'completed'); assert.equal(light.report, undefined); assert.equal(light.run.runtimeConfiguration, undefined);
  await f.write('app.py', 'changed after frozen review\n');
  const evidence = (await call('read_evidence', { runId: done.runId, findingId: 'division' })).structuredContent;
  assert.match(evidence.source.text, /return total \/ count/); assert.equal(evidence.evidence.contentSha256, evidence.source.contentSha256);
  assert.equal(evidence.evidenceCount, 1);
  await f.write('app.py', 'def ratio(total, count):\n    return total / count\n');
  assert.equal(await f.git('status', '--porcelain'), before);
  const listed = (await call('list_reviews', {})).structuredContent;
  assert.equal(listed.reviews.length, 1); assert.equal(listed.reviews[0].taskId, taskId); assert.equal(listed.reviews[0].status, 'completed');
  assert.equal((await call('cancel_review', { taskId })).structuredContent.cancellationRequested, false);
});

test('no_changes and idempotent admission survive reconnect without a model session', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw Error('must not start'); });
  const requestId = randomUUID(), request = { requestId, scope: 'commits', base: f.base, head: f.base };
  await f.tasks.start(request); const done = await terminal(f.tasks, requestId);
  assert.equal(done.status, 'no_changes'); assert.equal(done.runId, undefined); assert.equal(calls, 0);
  const reconnected = f.track(await ReviewTasks.create(f.host, async () => { throw Error('must not restart'); }));
  assert.deepEqual(await reconnected.get(requestId), done);
  assert.equal((await reconnected.start(request)).status, 'no_changes');
  await assert.rejects(reconnected.start({ requestId }), /different review/);
  assert.equal((await reconnected.list()).reviews[0].status, 'no_changes');
});

test('parallel starts are bounded and cancellation is confirmed by the native report', async t => {
  const f = await fixture(t, scriptedRuntime(async () => new Promise(() => {})));
  const starts = await Promise.allSettled([f.tasks.start({}), f.tasks.start({})]);
  assert.equal(starts.filter(item => item.status === 'fulfilled').length, 1);
  const started = starts.find(item => item.status === 'fulfilled').value;
  await reviewing(f.tasks, started.taskId);
  const requested = await f.tasks.cancel(started.taskId);
  assert.equal(requested.cancellationRequested, true); assert.equal(requested.status, 'running'); assert.equal(requested.done, false);
  const done = await terminal(f.tasks, started.taskId);
  await assertStatus(f, done, 'cancelled'); assert.equal(done.run.termination.reason, 'cancelled');
  assert.equal(done.report.status, 'cancelled'); assert.deepEqual(await readdir(join(f.state, 'locks')), []);
});

test('cancelling a polling RPC does not cancel the accepted review', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, scriptedRuntime(async tools => { await gate; await submitFinding(tools); }));
  const { call } = await connected(t, f.tasks);
  const { taskId } = (await call('start_review')).structuredContent;
  await reviewing(f.tasks, taskId);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(call('get_review', { id: taskId }, { signal: abort.signal }));
  assert.equal((await f.tasks.get(taskId)).cancellationRequested, false);
  release(); assert.equal((await terminal(f.tasks, taskId)).status, 'completed');
});

test('server shutdown aborts work and reconnect cannot invent success', async t => {
  const f = await fixture(t, scriptedRuntime(async () => new Promise(() => {})));
  const { taskId } = await f.tasks.start({}); await reviewing(f.tasks, taskId);
  await f.tasks.close(); const done = await f.tasks.get(taskId);
  assert.equal(done.status, 'cancelled'); assert.equal(done.run.termination.reason, 'cancelled');
  const restarted = f.track(await ReviewTasks.create(f.host, scriptedRuntime(submitFinding)));
  assert.equal((await restarted.get(taskId)).status, 'cancelled');
  await assert.rejects(f.tasks.start({}), /closing/);
});

test('dead owner with a running native manifest is interrupted, never completed', async t => {
  const f = await fixture(t); const { taskId } = await f.tasks.start({}); const done = await terminal(f.tasks, taskId);
  // Native delivery can precede the owner's final receipt write and active-map cleanup.
  // Finish that owner before simulating interruption and reconnecting to persisted state.
  await f.tasks.close();
  const restarted = f.track(await ReviewTasks.create(f.host, scriptedRuntime(submitFinding)));
  const taskPath = join(f.state, 'mcp', 'tasks', taskId, 'task.json');
  const receipt = JSON.parse(await readFile(taskPath, 'utf8')); receipt.owner = { id: randomUUID(), pid: process.pid };
  delete receipt.finishedAt; await writeFile(taskPath, JSON.stringify(receipt));
  const runPath = join(f.state, 'runs', done.runId, 'run.json');
  const run = JSON.parse(await readFile(runPath, 'utf8')); run.status = 'running'; delete run.outcome; await writeFile(runPath, JSON.stringify(run));
  const status = await restarted.get(taskId); assert.equal(status.status, 'interrupted'); assert.equal(status.done, true); assert.equal(status.report, undefined);
  assert.equal((await restarted.get(done.runId)).liveness, 'unknown');
});

for (const [name, script, options, expected, reason] of [
  ['agent_end without final', async () => {}, {}, 'partial', 'incomplete'],
  ['tool budget', async tools => { await tools.read_diff({ path: 'app.py' }); await submitFinding(tools); }, { maxToolCalls: 1 }, 'partial', 'tool_budget'],
  ['provider error', async () => { throw Error('secret-provider-body'); }, {}, 'failed', 'runtime_error'],
]) test(`${name} stays ${expected} across the adapter`, async t => {
  const f = await fixture(t, scriptedRuntime(script));
  const { taskId } = await f.tasks.start(options); const done = await terminal(f.tasks, taskId);
  await assertStatus(f, done, expected); assert.equal(done.run.termination.reason, reason);
  assert.doesNotMatch(JSON.stringify(done), /secret-provider-body/);
});

test('time budget stays partial after the runtime starts', { timeout: 30_000 }, async t => {
  let ready; const startedReview = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, scriptedRuntime(async () => { ready(); await new Promise(() => {}); }));
  // Expire the engine's own timer after entering review, independent of Windows Git latency.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { taskId } = await f.tasks.start({ timeoutMs: 60_000 });
    await startedReview; t.mock.timers.tick(60_000); t.mock.timers.reset();
    const done = await terminal(f.tasks, taskId);
    await assertStatus(f, done, 'partial'); assert.equal(done.run.termination.reason, 'time_budget');
  } finally { t.mock.timers.reset(); }
});

test('factory errors and delivery failures expose no unconfirmed Report or provider secrets', async t => {
  const f = await fixture(t, async () => { throw Error('oauth-token api-key session-credential'); });
  let { taskId } = await f.tasks.start({}); let done = await terminal(f.tasks, taskId);
  assert.equal(done.status, 'delivery_failed'); assert.equal(done.report, undefined);
  assert.doesNotMatch(JSON.stringify(done), /oauth-token|api-key|session-credential/);
  const failing = f.track(await ReviewTasks.create(f.host, scriptedRuntime(async (tools, options) => { await submitFinding(tools); await mkdir(join(options.runDir, 'report.md')); })));
  ({ taskId } = await failing.start({})); done = await terminal(failing, taskId);
  assert.equal(done.status, 'delivery_failed'); assert.equal(done.report, undefined);
});

test('bad Git input fails before a native run and remains in task history', async t => {
  const f = await fixture(t);
  const { taskId } = await f.tasks.start({ scope: 'commits', base: 'missing-ref', head: f.base });
  const done = await terminal(f.tasks, taskId); assert.equal(done.status, 'failed'); assert.equal(done.runId, undefined);
  assert.equal((await f.tasks.list()).reviews[0].taskId, taskId);
});

test('schema rejects path/credential overrides, traversal, invalid scopes and budgets', async t => {
  let sessions = 0; const f = await fixture(t, async () => { sessions++; throw Error('must not start'); });
  const { call } = await connected(t, f.tasks);
  for (const input of [
    { repositoryPath: f.repository }, { stateDir: join(f.repository, 'state') }, { apiKey: 'secret-value' }, { auth: 'oauth' },
    { model: 'override' }, { evaluation: { tools: 'text-only' } }, { scope: 'staged', base: f.base }, { scope: 'commits' },
    { scope: 'staged', includeUntracked: ['app.py'] }, { scope: 'worktree', includeUntracked: ['../auth/auth.json'] },
    { timeoutMs: 0 }, { maxToolCalls: 1001 },
  ]) {
    const response = await call('start_review', input); assert.equal(response.isError, true); assert.doesNotMatch(JSON.stringify(response), /secret-value/);
  }
  for (const name of ['get_review', 'read_evidence', 'cancel_review']) {
    const input = name === 'get_review' ? { id: '../auth/auth.json' } : name === 'cancel_review' ? { taskId: '../auth/auth.json' } : { runId: '../auth/auth.json', findingId: 'x' };
    assert.equal((await call(name, input)).isError, true);
  }
  assert.equal(sessions, 0); assert.deepEqual((await f.tasks.list()).reviews, []);
  await assert.rejects(ReviewTasks.create({ ...f.host, stateDir: join(f.repository, 'state') }, scriptedRuntime(submitFinding)), /outside and separate/);
});

test('state admission resolves junction aliases before accepting a state path', async t => {
  const f = await fixture(t);
  const { symlink } = await import('node:fs/promises');
  const alias = join(f.directory, 'checkout-alias'); await symlink(f.repository, alias, 'junction');
  await assert.rejects(ReviewTasks.create({ ...f.host, stateDir: join(alias, 'state') }, scriptedRuntime(submitFinding)), /outside and separate/);
});

test('history and direct lookups enforce the fixed repository even in shared state', async t => {
  const f = await fixture(t); const other = await repositoryFixture(t); const head = await other.change();
  const foreign = await new ReviewEngine(scriptedRuntime(submitFinding)).run({ repositoryPath: other.repository, stateDir: f.state,
    model: f.host.model, input: { kind: 'commits', base: other.base, head }, skills: 'off', learn: 'off' });
  assert.deepEqual((await f.tasks.list()).reviews, []);
  await assert.rejects(f.tasks.get(foreign.runId), /another configured repository/);
  await assert.rejects(f.tasks.evidence(foreign.runId, 'division'), /another configured repository/);
  const { taskId } = await f.tasks.start({}); const done = await terminal(f.tasks, taskId);
  const reconnected = f.track(await ReviewTasks.create(f.host, scriptedRuntime(submitFinding)));
  assert.equal((await reconnected.get(taskId)).report.runId, done.runId);
  assert.equal((await reconnected.list()).reviews.length, 1);
});

for (const artifact of ['report.json', 'report.md']) test(`tampered ${artifact} is refused by status and successful history`, async t => {
  const f = await fixture(t); const { taskId } = await f.tasks.start({}); const done = await terminal(f.tasks, taskId);
  await writeFile(join(f.state, 'runs', done.runId, artifact), 'tampered');
  const { call } = await connected(t, f.tasks);
  assert.equal((await call('get_review', { id: taskId, includeReport: false })).isError, true);
  assert.equal((await call('read_evidence', { runId: done.runId, findingId: 'division' })).isError, true);
  assert.deepEqual((await f.tasks.list()).reviews, []);
});

test('evidence reuses existing integrity validation and cannot select an arbitrary file', async t => {
  const f = await fixture(t); const { taskId } = await f.tasks.start({}); const done = await terminal(f.tasks, taskId);
  await assert.rejects(f.tasks.evidence(done.runId, '../auth/auth.json'), /not in the verified report/);
  await assert.rejects(f.tasks.evidence(done.runId, 'division', 1), /outside/);
  const store = await SnapshotStore.load(f.state, done.report.snapshot.id);
  await writeFile(join(f.state, 'blobs', store.manifest.head['app.py'].hash), 'corrupt frozen source');
  await assert.rejects(f.tasks.evidence(done.runId, 'division'), /existing source integrity check/);
});
