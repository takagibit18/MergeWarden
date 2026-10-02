import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewEngine } from '../src/engine/review.ts';
import { history, readReport } from '../src/engine/reports.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { repositoryFixture } from './repository-fixture.mjs';
async function setup(t) {
  const f = await repositoryFixture(t); const head = await f.change();
  return { ...f, options: { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' } } };
}
function runtime(script, journal = new MemoryJournal()) {
  return async options => ({ journal, async prompt(_text, signal) { const tools = Object.fromEntries(options.tools.map(t => [t.name, t.execute])); await script(tools, options, signal); }, async abort() {}, dispose() {}, usage: () => ({input: 10, output: 5, total: 15}) });
}
async function submit(tools, findings = []) { await tools.read_diff({ path: 'app.py' }); return tools.submit_review({ summary: 'Offline fixture review only.', reviewedPaths: ['app.py'], findings }); }

test('complete pipeline persists verifiable advisory reports and token usage', async t => {
  const f = await setup(t);
  const result = await new ReviewEngine(runtime(async tools => {
    const source = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
    const { snapshotId, revision, path, startLine, endLine, contentSha256 } = source;
    await submit(tools, [{ id: 'division', title: 'Zero division', claim: 'Zero count raises.', trigger: 'count=0', impact: 'request fails', severity: 'high', evidence: [{ snapshotId, revision, path, startLine, endLine, contentSha256 }] }]);
  })).run(f.options);
  assert.equal(result.report.status, 'completed'); assert.equal(result.report.findings.length, 1);
  assert.deepEqual(await readReport(f.state, result.runId), result.report);
  assert.match(await readFile(result.markdownPath, 'utf8'), /Zero division/);
  const [m] = await history(f.state); assert.equal(m.status, 'delivered'); assert.equal(m.usage.total, 15);
  await f.write('app.py', 'later edit'); assert.deepEqual(await readReport(f.state, result.runId), result.report);
});

test('empty change is no_changes without creating a model session', async t => {
  const f = await setup(t); let calls = 0;
  const result = await new ReviewEngine(async () => { calls++; throw Error('unexpected'); }).run({ ...f.options, input: {kind:'commits', base:f.base, head:f.base} });
  assert.equal(result.kind, 'no_changes'); assert.equal(calls, 0); assert.deepEqual(await history(f.state), []);
});

test('model end without final submission remains partial', async t => {
  const f = await setup(t); const r = await new ReviewEngine(runtime(async () => {})).run(f.options); assert.equal(r.report.status, 'partial');
});

test('submission requires complete diff coverage and valid evidence', async t => {
  const f = await setup(t); const r = await new ReviewEngine(runtime(async tools => {
    await assert.rejects(tools.submit_review({summary:'not read', reviewedPaths:['app.py'], findings:[]}), /complete diff/);
    await tools.read_diff({ path: 'app.py', limit: 1 });
    await assert.rejects(tools.submit_review({summary:'partly read', reviewedPaths:['app.py'], findings:[]}), /complete diff/);
    await tools.read_diff({ path: 'app.py' });
    const s = await tools.read_source({ revision:'head', path:'app.py', startLine:1, endLine:2 });
    const candidate = { id:'bad', title:'bad', claim:'bad', trigger:'bad', impact:'bad', severity:'high', evidence:[{ snapshotId:s.snapshotId, revision:'head', path:'app.py', startLine:1, endLine:2, contentSha256:'a'.repeat(64) }] };
    await assert.rejects(tools.submit_review({summary:'bad hash', reviewedPaths:['app.py'], findings:[candidate]}), /hash mismatch/);
    await submit(tools);
    await assert.rejects(tools.submit_review({summary:'duplicate', reviewedPaths:['app.py'], findings:[]}), /already submitted/);
  })).run(f.options); assert.equal(r.report.status, 'completed'); assert.equal(r.report.findings.length, 0);
});

test('explicitly omitted coverage remains partial even with a final batch', async t => {
  const f = await setup(t); const r = await new ReviewEngine(runtime(tools => tools.submit_review({summary:'Could not inspect scope.', reviewedPaths:[], findings:[]}))).run(f.options);
  assert.equal(r.report.status, 'partial'); assert.match(r.report.summary, /Could not inspect/);
});

test('provider errors and invalid credentials are failed without leaking response bodies', async t => {
  const f = await setup(t); const r = await new ReviewEngine(runtime(async () => { throw Error('401 secret-key'); })).run(f.options);
  assert.equal(r.report.status, 'failed'); assert.doesNotMatch(JSON.stringify(r), /secret-key/);
});

test('cancellation saves a cancelled report and releases the repository lock', async t => {
  const f = await setup(t); const abort = new AbortController();
  const r = await new ReviewEngine(runtime(async () => { throw Error('should not start'); })).run({...f.options, signal:abort.signal}, e => {if(e.phase==='reviewing') abort.abort();});
  assert.equal(r.report.status, 'cancelled'); assert.deepEqual(await readdir(join(f.state, 'locks')), []);
});

test('time and tool budgets cannot become completed reviews', async t => {
  const f = await setup(t);
  const tools = await new ReviewEngine(runtime(async tools => { await tools.read_diff({path:'app.py'}); await submit(tools); })).run({...f.options, maxToolCalls:1});
  assert.equal(tools.report.status, 'partial'); assert.match(tools.report.summary, /tool budget/);
  const [budgetManifest] = await history(f.state);
  assert.deepEqual({requested:budgetManifest.metrics.toolRequests,accepted:budgetManifest.metrics.toolAccepted,executed:budgetManifest.metrics.toolExecuted,rejected:budgetManifest.metrics.toolRejected},{requested:2,accepted:1,executed:1,rejected:1});
  const time = await new ReviewEngine(runtime(async () => new Promise(() => {}))).run({...f.options, timeoutMs:5000});
  assert.equal(time.report.status, 'partial'); assert.match(time.report.summary, /time budget/);
});

test('cancellation stops admission and does not wait forever for an ignoring runtime', async t => {
  const f = await setup(t); const abort = new AbortController(); let lateExecution = false;
  const factory = async options => ({
    journal:new MemoryJournal(),
    async prompt() {
      await options.tools.find(tool=>tool.name==='read_diff').execute({path:'app.py'});
      abort.abort();
      await assert.rejects(options.tools.find(tool=>tool.name==='search_text').execute({revision:'head',query:'ratio'}));
      lateExecution = true;
      await new Promise(()=>{});
    },
    async abort(){ await new Promise(()=>{}); }, dispose(){}, usage(){return {input:0,output:0,total:0};}
  });
  const started=performance.now(); const r=await new ReviewEngine(factory).run({...f.options,signal:abort.signal});
  assert.equal(r.report.status,'cancelled'); assert.ok(performance.now()-started<4000); assert.equal(lateExecution,true);
  const m=(await history(f.state))[0];assert.deepEqual({requested:m.metrics.toolRequests,accepted:m.metrics.toolAccepted,executed:m.metrics.toolExecuted,rejected:m.metrics.toolRejected},{requested:2,accepted:1,executed:1,rejected:1});
});

test('poisoned journal stops delivery and never publishes completed', async t => {
  const f = await setup(t); const memory = new MemoryJournal(); let poisoned = false; let delivered = false;
  const journal = { async append(event) { if (event.payload.type === 'final_batch.accepted') poisoned = true; if (poisoned) throw Error('disk failure'); await memory.append(event); }, readActiveBranch: () => memory.readActiveBranch() };
  await assert.rejects(new ReviewEngine(runtime(tools => submit(tools), journal), async () => { delivered = true; throw Error('unexpected'); }).run(f.options), /persistence failed/);
  assert.equal(delivered, false); const [m] = await history(f.state); assert.equal(m.status, 'delivery_failed');
  await assert.rejects(readReport(f.state, m.runId), /no confirmed/);
});

for (const blocker of ['report.json', 'report.md']) test(`report delivery failure at ${blocker} is not successful`, async t => {
  const f = await setup(t);
  await assert.rejects(new ReviewEngine(runtime(async (tools, options) => { await submit(tools); await mkdir(join(options.runDir, blocker)); })).run(f.options));
  const [m] = await history(f.state); assert.equal(m.status, 'delivery_failed'); await assert.rejects(readReport(f.state, m.runId), /no confirmed/);
});

test('interruption before delivery manifest cannot confirm a report', async t => {
  const f = await setup(t);
  await assert.rejects(new ReviewEngine(runtime(tools => submit(tools)), async (state, manifest, report) => {
    const run = join(state, 'runs', manifest.runId); await writeFile(join(run,'report.json'), JSON.stringify(report)); await writeFile(join(run,'report.md'),'partial delivery'); throw Error('interrupted before manifest');
  }).run(f.options), /interrupted/);
  const [m] = await history(f.state); assert.equal(m.status, 'delivery_failed'); await assert.rejects(readReport(f.state,m.runId), /no confirmed/);
});

test('rerun creates a new run on the original immutable snapshot', async t => {
  const f = await setup(t),seen=[],factory=runtime(tools => submit(tools));
  const engine = new ReviewEngine(options=>{seen.push(options.inference);return factory(options);});
  const low={thinkingLevel:'low',maxOutputTokens:8192},high={thinkingLevel:'high',maxOutputTokens:16384};
  const first = await engine.run({...f.options,inference:low});
  await f.write('app.py','totally different\n'); const second = await engine.run({...f.options, inference:high, input:undefined, rerunId:first.runId});
  assert.deepEqual(seen,[low,high]);
  assert.notEqual(first.runId, second.runId); assert.equal(first.report.snapshot.id, second.report.snapshot.id);
  assert.equal((await history(f.state)).find(m=>m.runId===second.runId).parentRunId,first.runId);
  await assert.rejects(engine.run({...f.options, rerunId:first.runId, model:{provider:'other',modelId:'offline'}}),/same repository and model/);
});

test('repository lock excludes concurrent review and is released on factory failure', async t => {
  const f = await setup(t); let nestedRejected=false;
  await assert.rejects(new ReviewEngine(async () => { await assert.rejects(new ReviewEngine(runtime(tools => submit(tools))).run(f.options), /already running/); nestedRejected=true; throw Error('factory failed'); }).run(f.options),/factory failed/);
  assert.equal(nestedRejected,true); assert.deepEqual(await readdir(join(f.state,'locks')),[]);
});

test('report tampering fails verification and disappears from successful history', async t => {
  const f = await setup(t); const r = await new ReviewEngine(runtime(tools => submit(tools))).run(f.options);
  await writeFile(r.markdownPath,'changed'); await assert.rejects(readReport(f.state,r.runId),/integrity/); assert.deepEqual(await history(f.state),[]);
});
