import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { NavigationRecorder } from '../src/engine/navigation-recorder.ts';
import { NAVIGATION_FILE } from '../src/engine/navigation-contracts.ts';
import { readRun } from '../src/engine/reports.ts';
import { sha256 } from '../src/infrastructure/files.ts';
import { VerifiedArtifacts } from '../src/application/workbench/verified-artifacts.ts';
import { projectNavigation, validateNavigation } from '../src/application/workbench/navigation-view.ts';
import { navigationMermaid } from '../src/application/workbench/navigation-mermaid.ts';
import { repositoryFixture } from './repository-fixture.mjs';

const SNAPSHOT = 'a'.repeat(64), RUN = '00000000-0000-4000-8000-000000000001';
const entity = (id, extra = {}) => ({ id, snapshotId: SNAPSHOT, kind: 'function', functionKind: 'function', path: 'app.py', qualifiedName: `app.${id}`, name: id, startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, ...extra });
const relation = (id, fromId, toId, extra = {}) => ({ id, snapshotId: SNAPSHOT, fromId, toId, relation: 'CALLS', resolution: 'resolved_scoped', sourcePath: 'use.py', sourceLine: 4, sourceEndLine: 4, sourceColumn: 0, sourceEndColumn: 9, siteId: 's', resolverVersion: 'r', ...extra });
const page = (items, extra = {}) => ({ status: 'ok', snapshotId: SNAPSHOT, revision: 'head', items, truncated: false, coverage: {}, warnings: [], generationId: 'g1', generationState: 'ready', ...extra });
const recorder = (extra = {}) => new NavigationRecorder({ runId: RUN, snapshotId: SNAPSHOT, toolExposure: 'text+graph', ...extra });

test('recorder copies graph pages, normalises inputs and emits a deterministic record', () => {
  const r = recorder(); const lookup = page([entity('ratio')]); const before = JSON.stringify(lookup);
  r.graphPage('graph_lookup', { query: 'ratio', limit: 10, cursor: 'abc', secret: 'dropped' }, lookup);
  assert.equal(JSON.stringify(lookup), before, 'the model-visible page is never mutated');
  lookup.items[0].name = 'mutated-after-recording';
  r.graphPage('graph_neighbors', { symbolId: 'ratio', relation: 'CALLS', direction: 'incoming', limit: 5 }, page([relation('e1', 'mean', 'ratio'), relation('e1', 'mean', 'ratio')], { truncated: true }));
  assert.deepEqual(r.missingEntityIds(), ['mean']);
  r.describe([entity('mean', { path: 'use.py', startLine: 3, endLine: 4 })]);
  const record = r.finish();
  assert.deepEqual(record.steps.map(s => [s.seq, s.op, s.pageTruncated, s.entityIds, s.relationIds]), [[1, 'graph_lookup', false, ['ratio'], []], [2, 'graph_neighbors', true, [], ['e1']]]);
  assert.deepEqual(record.steps[0].input, { query: 'ratio', limit: 10, paged: true });
  assert.deepEqual(record.entities.map(e => [e.id, e.name]), [['mean', 'mean'], ['ratio', 'ratio']]);
  assert.equal(record.relations.length, 1); assert.equal(record.entityFactsComplete, true); assert.deepEqual(record.generationIds, ['g1']);
  assert.equal(JSON.stringify(recorder().finish()), JSON.stringify(recorder().finish()), 'empty records are stable');
});

test('recorder limits truncate instead of failing, and a foreign snapshot makes the record unavailable', () => {
  const r = recorder({ limits: { maxSteps: 1, maxEntities: 1 } });
  r.graphPage('graph_lookup', { query: 'x', limit: 2 }, page([entity('a'), entity('b')]));
  r.graphPage('graph_lookup', { query: 'y', limit: 2 }, page([]));
  const record = r.finish(); assert.equal(record.truncated, true); assert.equal(record.steps.length, 1); assert.equal(record.entities.length, 1);
  const foreign = recorder(); foreign.graphPage('graph_lookup', { query: 'x', limit: 1 }, page([], { snapshotId: 'b'.repeat(64) }));
  assert.equal(foreign.finish(), undefined); assert.match(foreign.failure, /another snapshot/);
});

test('graph errors are recorded as coverage-limited steps and never as absence', () => {
  const r = recorder(); r.graphError('graph_neighbors', { symbolId: 'x', relation: 'CALLS', direction: 'incoming', limit: 5 }, new Error('Graph worker failed'));
  const [step] = r.finish().steps; assert.equal(step.status, 'error'); assert.equal(step.coverageLimited, true); assert.match(step.error, /worker failed/);
});

test('host investigation paths become definite edges with upstream steps reversed', () => {
  const r = recorder({ toolExposure: 'text+locagent' });
  const root = { entityId: 'ratio', snapshotId: SNAPSHOT, path: 'app.py', name: 'ratio', qualifiedName: 'app.ratio', kind: 'function', startLine: 1, endLine: 2 };
  const caller = { ...root, entityId: 'mean', path: 'use.py', name: 'mean', qualifiedName: 'use.mean', startLine: 3, endLine: 4 };
  const pack = { version: 'structural-dispatch-2', origin: 'host_dispatch', requestId: 'req', runId: RUN, snapshotId: SNAPSHOT, generationId: 'g1', route: { routeType: 'CALLER_CHECK', reason: 'r' },
    investigations: [{ investigationId: 'inv', routeId: 'route', routeType: 'CALLER_CHECK', reason: 'r', snapshotId: SNAPSHOT, status: 'delivered', limitations: ['bounded'], prefetchedSourceRefs: [], rootsResolved: 1, rootsExplored: 1, rootsOmittedByBudget: 0,
      changeUnits: [{ changeUnitId: 'cu', snapshotId: SNAPSHOT, path: 'app.py', kind: 'function', changedRanges: [{ startLine: 2, endLine: 2 }], entity: root, resolution: 'resolved', provenance: { inputIndices: [0], source: 'immutable_head_diff' } }],
      candidateCatalog: [{ candidateRefId: 'cand', entity: caller, roots: [{ changeUnitId: 'cu', path: 'app.py', name: 'ratio' }], depth: 1, structuralPaths: [{ relationSequence: ['CALLS'], directionSequence: ['upstream'], entityIds: ['ratio', 'mean'], edgeIds: ['edge-1'] }], patternIds: [], pathSupportCount: 1, changed: false, alreadyVisible: false, classification: 'production', explorationOnly: true }] }],
    sources: [], omitted: [], omittedCandidateCount: 0, limitations: [], terminal: 'context_returned' };
  r.investigationDelivered(pack); r.candidateExpanded('cand', caller, 'req', 'g1');
  const record = r.finish();
  assert.deepEqual(record.relations.map(e => [e.id, e.fromId, e.toId, e.relation, e.resolution, e.origin]), [['edge-1', 'mean', 'ratio', 'CALLS', 'definite', 'host_investigation']]);
  assert.deepEqual(record.steps.map(s => s.op), ['investigation_delivered', 'candidate_expanded']);
  assert.deepEqual(record.candidates, [{ candidateRefId: 'cand', entityId: 'mean', rootChangeUnitIds: ['cu'], depth: 1, requestId: 'req' }]);
  assert.match(record.limitations[0], /LocAgent retrieval calls/);
  const view = projectNavigation(record, { findings: [{ id: 'f1', evidence: [{ revision: 'head', path: 'use.py', startLine: 4, endLine: 4 }] }] }, ['app.py']);
  const roles = Object.fromEntries(view.nodes.map(n => [n.id, n.roles]));
  assert.deepEqual(roles.ratio, ['change_root', 'in_changed_file', 'visited']);
  assert.deepEqual(roles.mean, ['evidence_overlap', 'expanded', 'candidate', 'visited']);
  assert.deepEqual(view.nodes.find(n => n.id === 'mean').findingIds, ['f1']);
});

test('validation rejects records that do not belong to the frozen run', () => {
  const r = recorder(); r.graphPage('graph_lookup', { query: 'ratio', limit: 1 }, page([entity('ratio')]));
  const record = r.finish(); const expected = { runId: RUN, snapshotId: SNAPSHOT, headPaths: ['app.py'] };
  assert.equal(validateNavigation(structuredClone(record), expected).steps.length, 1);
  assert.throws(() => validateNavigation({ ...record, runId: '00000000-0000-4000-8000-000000000002' }, expected), /identity/);
  assert.throws(() => validateNavigation(record, { ...expected, headPaths: ['other.py'] }), /outside the frozen head/);
  assert.throws(() => validateNavigation({ ...record, steps: [{ ...record.steps[0], entityIds: ['ghost'] }] }, expected), /unknown facts/);
  assert.throws(() => validateNavigation({ ...record, relations: [{ id: 'x', fromId: 'a', toId: 'b', relation: 'CALLS', resolution: 'guessed', origin: 'graph_neighbors' }] }, expected), /relation/);
});

test('mermaid export is deterministic, escapes labels and draws candidate edges dotted', () => {
  const view = { toolExposure: 'text+graph', generationIds: [], truncated: false, entityFactsComplete: true, limitations: [], steps: [],
    nodes: [{ id: 'b', kind: 'function', path: 'use.py', qualifiedName: 'use.mean', name: 'mean"<x>', startLine: 3, endLine: 4, roles: ['evidence_overlap'], findingIds: ['f'], firstSeq: 2 },
      { id: 'a', kind: 'function', path: 'app.py', qualifiedName: 'app.ratio', name: 'ratio', startLine: 1, endLine: 2, roles: ['in_changed_file'], findingIds: [], firstSeq: 1 }],
    edges: [{ id: 'e', fromId: 'b', toId: 'a', relation: 'CALLS', resolution: 'resolved_scoped', origin: 'graph_neighbors', firstSeq: 2 },
      { id: 'c', fromId: 'a', toId: 'b', relation: 'IMPORTS', resolution: 'candidate', origin: 'graph_neighbors', firstSeq: 3 }] };
  const text = navigationMermaid(view);
  assert.equal(text, navigationMermaid(structuredClone(view)));
  assert.match(text, /^flowchart LR\n/); assert.match(text, /n1\["mean#34;#60;x#62; L3"\]/); assert.match(text, /n1 -->\|CALLS\| n0/); assert.match(text, /n0 -.->\|IMPORTS\| n1/);
  assert.doesNotMatch(text, /mean"</);
  assert.match(navigationMermaid(view, { maxNodes: 1 }), /1 more node\(s\) omitted/);
});

// --- Engine and Workbench integration over a real frozen snapshot and graph ---

const runtime = script => async options => ({ journal: new MemoryJournal(), async prompt() { await script(Object.fromEntries(options.tools.map(t => [t.name, t.execute]))); }, async abort() {}, dispose() {}, usage: () => ({ input: 0, output: 0, total: 0 }) });
async function setup(t) {
  const f = await repositoryFixture(t, { 'app.py': 'def ratio(total, count):\n    return total / max(count, 1)\n', 'use.py': 'from app import ratio\n\ndef mean(values):\n    return ratio(sum(values), len(values))\n' });
  const head = await f.change();
  return { ...f, options: { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' } } };
}
const artifacts = async (f, runId) => {
  const repositoryPath = (await readRun(f.state, runId)).repositoryPath, at = new Date().toISOString();
  return new VerifiedArtifacts({ id: 'project', name: 'fixture', repositoryPath, createdAt: at, workspaces: [{ id: 'w'.repeat(64), name: 'fixture', path: repositoryPath, kind: 'primary', registeredAt: at }] }, f.state);
};
const graphReview = (hook = async () => {}) => runtime(async tools => {
  const found = await tools.graph_lookup({ query: 'ratio', limit: 10 }); const target = found.items.find(item => item.kind === 'function');
  const callers = await tools.graph_neighbors({ symbolId: target.id, relation: 'CALLS', direction: 'incoming', limit: 10 });
  assert.equal(callers.items.length, 1); assert.equal(Object.keys(callers).some(key => /navigation/i.test(key)), false);
  await tools.read_diff({ path: 'app.py' }); const source = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
  await hook();
  await tools.submit_review({ summary: 'Synthetic navigation test', reviewedPaths: ['app.py'], findings: [{ id: 'div', title: 'Division by zero', claim: 'count may be zero', trigger: 'count == 0', impact: 'ZeroDivisionError', severity: 'high', evidence: [{ evidenceRefId: source._mergewarden.evidenceRefId }] }] });
});

test('a graph-enabled review delivers a hashed, verifiable navigation record described from the graph', async t => {
  const f = await setup(t); const r = await new ReviewEngine(graphReview()).run(f.options);
  assert.equal(r.report.status, 'completed');
  const run = await readRun(f.state, r.runId); assert.equal(run.navigation.state, 'recorded');
  const text = await readFile(join(f.state, 'runs', r.runId, NAVIGATION_FILE), 'utf8'); assert.equal(sha256(text), run.navigation.sha256);
  const record = JSON.parse(text); assert.equal(record.entityFactsComplete, true);
  assert.deepEqual(record.steps.map(s => s.op), ['graph_lookup', 'graph_neighbors']);
  assert.ok(record.entities.some(e => e.name === 'mean' && e.path === 'use.py'), 'the caller endpoint is described without a model-visible call');
  assert.equal(run.metrics.graph.calls, 2, 'describe is not counted as a graph tool call');
  const a = await artifacts(f, r.runId); const response = await a.navigation(r.runId);
  assert.equal(response.state, 'recorded'); assert.equal(response.view.edges.length, 1);
  const ratio = response.view.nodes.find(n => n.name === 'ratio' && n.kind === 'function');
  assert.ok(ratio.roles.includes('in_changed_file') && ratio.roles.includes('evidence_overlap')); assert.deepEqual(ratio.findingIds, ['div']);
  const source = await a.navigationSource(r.runId, ratio.id); assert.equal(source.source.path, 'app.py'); assert.match(source.source.text, /return total \/ count/);
  await assert.rejects(a.navigationSource(r.runId, 'not-in-record'), e => e.code === 'NOT_FOUND');
  await writeFile(join(f.state, 'runs', r.runId, NAVIGATION_FILE), text.replace('mean', 'mead'));
  await assert.rejects(a.navigation(r.runId), e => e.code === 'REPORT_INTEGRITY');
  await rm(join(f.state, 'runs', r.runId, NAVIGATION_FILE)); await symlink(join(f.state, 'runs', r.runId, 'report.json'), join(f.state, 'runs', r.runId, NAVIGATION_FILE));
  await assert.rejects(a.navigation(r.runId), e => e.code === 'REPORT_INTEGRITY');
});

test('a navigation write failure still delivers the report and marks navigation unavailable', async t => {
  const f = await setup(t);
  const r = await new ReviewEngine(graphReview(async () => { const [runId] = await readdir(join(f.state, 'runs')); await mkdir(join(f.state, 'runs', runId, NAVIGATION_FILE)); })).run(f.options);
  assert.equal(r.report.status, 'completed'); const run = await readRun(f.state, r.runId);
  assert.equal(run.status, 'delivered'); assert.deepEqual(run.navigation, { state: 'unavailable', reason: 'Navigation record could not be written' });
  const response = await (await artifacts(f, r.runId)).navigation(r.runId); assert.equal(response.state, 'unavailable'); assert.equal(response.view, undefined);
});

test('text-only and historical runs report not_recorded without a navigation file', async t => {
  const f = await setup(t);
  const r = await new ReviewEngine(runtime(async tools => { await tools.read_diff({ path: 'app.py' }); await tools.submit_review({ summary: 'text only', reviewedPaths: ['app.py'], findings: [] }); })).run({ ...f.options, evaluation: { tools: 'text-only' } });
  const run = await readRun(f.state, r.runId); assert.equal(run.navigation, undefined);
  await assert.rejects(readFile(join(f.state, 'runs', r.runId, NAVIGATION_FILE)), { code: 'ENOENT' });
  assert.deepEqual(await (await artifacts(f, r.runId)).navigation(r.runId), { runId: r.runId, snapshotId: run.snapshotId, state: 'not_recorded' });
});

test('a graph run without graph calls records an empty navigation and never builds a graph to describe it', async t => {
  const f = await setup(t);
  const r = await new ReviewEngine(runtime(async tools => { await tools.read_diff({ path: 'app.py' }); await tools.submit_review({ summary: 'no graph use', reviewedPaths: ['app.py'], findings: [] }); })).run(f.options);
  const run = await readRun(f.state, r.runId); assert.equal(run.navigation.state, 'recorded'); assert.equal(run.navigation.steps, 0);
  assert.equal(run.metrics.graph.workerStarts, 0);
});

test('CLI navigation verifies the delivered hash and prints Mermaid or JSON', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const { fileURLToPath } = await import('node:url');
  const exec = promisify(execFile); const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
  const f = await setup(t); const r = await new ReviewEngine(graphReview()).run(f.options);
  const call = args => exec(process.execPath, ['--experimental-strip-types', cli, 'navigation', '--run', r.runId, '--state', f.state, ...args], { windowsHide: true });
  const mermaid = (await call([])).stdout; assert.match(mermaid, /^flowchart LR/); assert.match(mermaid, /-->\|CALLS\|/);
  const json = JSON.parse((await call(['--format', 'json'])).stdout); assert.equal(json.edges.length, 1);
  const file = join(f.state, 'runs', r.runId, NAVIGATION_FILE); await writeFile(file, (await readFile(file, 'utf8')) + ' ');
  await assert.rejects(call([]), e => /does not match its delivered hash/.test(e.stderr));
});
