import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { SnapshotStore } from '../../../src/snapshot/store.ts';
import { GraphOpenError, SqliteCodeGraph, graphBuildAudit, graphCheckpointPath, publishedGraphPath } from '../../../src/graph/sqlite-store.ts';
import { LazyCodeGraph } from '../../../src/graph/lazy-graph.ts';
async function fixture(t, extra={}) { const f=await repositoryFixture(t,{'a.py':'def save(): pass\ndef first(): save()\ndef second(): save()\n',...extra}); const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head:f.base},configuration:{}}); return {...f,store,id:store.manifest.identity.id}; }
test('SQLite cache, snapshot isolation, stable rebuild and bounded pagination',async t=>{
  const f=await fixture(t); let {graph,metrics}=await SqliteCodeGraph.open(f.store); assert.equal(metrics.cacheHit,false);
  const lookup=await graph.lookup({snapshotId:f.id,query:'save',limit:5}); const symbol=lookup.items[0];
  const request={snapshotId:f.id,symbolId:symbol.id,relation:'CALLS',direction:'incoming',limit:1};
  const first=await graph.neighbors(request); const second=await graph.neighbors({...request,cursor:first.nextCursor}); assert.equal(first.truncated,true); assert.equal(second.truncated,false); assert.notEqual(first.items[0].id,second.items[0].id);
  await assert.rejects(graph.neighbors({...request,relation:'REFERENCES'}),/Invalid graph relation/);
  await assert.rejects(graph.lookup({snapshotId:'other',query:'save',limit:5}),/snapshot mismatch/);
  await assert.rejects(graph.neighbors({...request,direction:'outgoing',cursor:first.nextCursor}),/cursor/); graph.close();
  ({graph,metrics}=await SqliteCodeGraph.open(f.store)); assert.equal(metrics.cacheHit,true); graph.close();
  await rm(await publishedGraphPath(f.state,f.id)); ({graph}=await SqliteCodeGraph.open(f.store)); const rebuilt=await graph.neighbors(request); assert.deepEqual(rebuilt.items,first.items);assert.notEqual(rebuilt.generationId,first.generationId);await assert.rejects(graph.neighbors({...request,cursor:first.nextCursor}),/generation/); graph.close();
  await f.write('a.py','def unrelated(): pass\n'); const head=await f.commit(); const other=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{}});
  ({graph}=await SqliteCodeGraph.open(other)); assert.equal((await graph.lookup({snapshotId:other.manifest.identity.id,query:'save',limit:5})).items.length,0); await assert.rejects(graph.neighbors({...request,snapshotId:other.manifest.identity.id}),/Entity/);graph.close();
});
test('prepared-only open validates a published generation and never builds or quarantines',async t=>{
  const missing=await fixture(t);await assert.rejects(SqliteCodeGraph.openPublishedOnly(missing.store),error=>error instanceof GraphOpenError&&/never rebuilds/.test(error.warnings.at(-1)));
  await assert.rejects(publishedGraphPath(missing.state,missing.id),error=>error?.code==='ENOENT');
  const f=await fixture(t);const built=await SqliteCodeGraph.open(f.store);const generation=built.metrics.generationId;built.graph.close();
  const hot=await SqliteCodeGraph.openPublishedOnly(f.store);assert.equal(hot.metrics.cacheHit,true);assert.equal(hot.metrics.buildMs,0);assert.equal(hot.metrics.extractedFiles,0);assert.equal(hot.metrics.resolvedFiles,0);assert.equal(hot.metrics.generationId,generation);hot.graph.close();
  const path=await publishedGraphPath(f.state,f.id);await writeFile(path,'corrupt');
  await assert.rejects(SqliteCodeGraph.openPublishedOnly(f.store),error=>error instanceof GraphOpenError&&/Prepared-only/.test(error.message));
  assert.equal(await publishedGraphPath(f.state,f.id),path);
});
for(const damage of ['corrupt','version','parser','coverage','missing-edge']) test(`derived cache rebuilds ${damage} rather than querying false ready`,async t=>{
  const f=await fixture(t); const initial=await SqliteCodeGraph.open(f.store); initial.graph.close(); const path=await publishedGraphPath(f.state,f.id);
  if(damage==='corrupt') await writeFile(path,'not sqlite'); else { const db=new DatabaseSync(path); if(damage==='version')db.exec("UPDATE graph_snapshots SET resolver_version='old'"); else if(damage==='parser')db.exec("UPDATE graph_snapshots SET parser_version='old'"); else if(damage==='coverage')db.exec("UPDATE graph_snapshots SET coverage='{}'"); else if(damage==='missing-edge')db.exec("DELETE FROM relation_sites WHERE relation_id IN (SELECT relation_id FROM relations WHERE kind='CALLS'); DELETE FROM relations WHERE kind='CALLS'"); db.close(); }
  const {graph,metrics}=await SqliteCodeGraph.open(f.store); assert.equal(metrics.cacheHit,false); assert.ok(metrics.resumedFiles>0);assert.ok(metrics.resumedResolutionFiles>0);assert.equal(metrics.resolvedFiles,0); assert.equal((await graph.lookup({snapshotId:f.id,query:'save',limit:5})).items.length,1); graph.close();
});
test('empty graph results retain parse-incomplete coverage and uncertainty',async t=>{
  const f=await fixture(t,{'broken.py':'def broken(:\n','dynamic.py':'obj.save()\n'}); const {graph}=await SqliteCodeGraph.open(f.store);
  const result=await graph.lookup({snapshotId:f.id,query:'missing',limit:10}); assert.equal(result.status,'parse_incomplete'); assert.equal(result.items.length,0); assert.equal(result.coverage.parseIncompleteFiles,1); assert.equal(result.coverage.unresolvedCalls,1);assert.ok(result.warnings.some(w=>w.includes('never prove absence'))); graph.close();
});
test('worker cancellation stops a cold build and can rebuild afterwards',async t=>{
  const f=await fixture(t); const graph=new LazyCodeGraph(f.state,f.id); const abort=new AbortController(); const request=graph.lookup({snapshotId:f.id,query:'save',limit:10},abort.signal); setTimeout(()=>abort.abort(new Error('cancel fixture')),10); await assert.rejects(request,/cancel fixture/);
  const page=await graph.lookup({snapshotId:f.id,query:'save',limit:10}); assert.equal(page.status,'ok'); assert.equal(page.items.length,1);await graph.dispose();
});

test('capacity publishes only complete file checkpoints and reports the omitted range',async t=>{
  const f=await fixture(t,{'a.py':'def alpha(): pass\n','b.py':'def beta(): pass\n','c.py':'def gamma(): pass\n'});
  const budget={maxFacts:6,maxRelations:100,maxFileFacts:100,maxFileMs:5000};
  const {graph,metrics}=await SqliteCodeGraph.open(f.store,{budget});
  const page=await graph.lookup({snapshotId:f.id,query:'gamma',limit:10});
  assert.equal(page.status,'partial');assert.equal(page.generationState,'partial');assert.equal(page.items.length,0);
  assert.equal(page.coverage.indexedFiles,1);assert.equal(page.coverage.omittedFiles,2);assert.match(page.coverage.limitReason,/fact budget/);
  const audit=await graphBuildAudit(f.state,f.id,budget);assert.deepEqual(audit.files.map(row=>row.path),['a.py']);assert.deepEqual(audit.resolutionFiles.map(row=>row.path),['a.py']);graph.close();
  const again=await SqliteCodeGraph.open(f.store,{budget});assert.equal(again.metrics.cacheHit,true);assert.equal((await graphBuildAudit(f.state,f.id,budget)).attempts,1);again.graph.close();
});

test('deterministic resolver capacity failure is cached without repeating extraction',async t=>{
  const f=await fixture(t);const budget={maxFacts:1000,maxRelations:1,maxFileFacts:1000,maxFileMs:5000};
  await assert.rejects(SqliteCodeGraph.open(f.store,{budget}),/relation limit/);const first=await graphBuildAudit(f.state,f.id,budget);assert.equal(first.attempts,1);assert.ok(first.files.length);
  await assert.rejects(SqliteCodeGraph.open(f.store,{budget}),error=>error instanceof GraphOpenError&&error.status==='error');const second=await graphBuildAudit(f.state,f.id,budget);assert.equal(second.attempts,1);assert.deepEqual(second.files,first.files);
});

test('resolver failure keeps committed file checkpoints private and preserves a valid generation',async t=>{
  const f=await fixture(t,{
    'a.py':'def a(): pass\ndef run_a(): a()\n',
    'b.py':'def b(): pass\ndef run_b(): b()\n',
    'c.py':'def c(): pass\ndef run_c(): c()\n'
  });
  const valid=await SqliteCodeGraph.open(f.store);valid.graph.close();const validPath=await publishedGraphPath(f.state,f.id);
  // Nine structural edges plus the first file call fit. The second file crosses
  // the limit after a.py's relationship checkpoint has committed.
  const budget={maxFacts:1000,maxRelations:10,maxFileFacts:1000,maxFileMs:5000};
  await assert.rejects(SqliteCodeGraph.open(f.store,{budget}),/relation limit/);
  const audit=await graphBuildAudit(f.state,f.id,budget);assert.deepEqual(audit.resolutionFiles.map(row=>row.path),['a.py']);
  await assert.rejects(publishedGraphPath(f.state,f.id,budget),error=>error?.code==='ENOENT');
  assert.equal(await publishedGraphPath(f.state,f.id),validPath);
  const reopened=await SqliteCodeGraph.open(f.store);assert.equal(reopened.metrics.cacheHit,true);assert.equal((await reopened.graph.lookup({snapshotId:f.id,query:'run_c',limit:5})).items.length,1);reopened.graph.close();
});

test('simulated disk-full publication records a transient reason and resumes without re-extraction',async t=>{
  const f=await fixture(t);const budget={maxFacts:1001,maxRelations:1001,maxFileFacts:1001,maxFileMs:5001};
  await assert.rejects(SqliteCodeGraph.open(f.store,{budget,testFault:'publish_enospc'}),error=>error?.code==='ENOSPC'&&/disk full/.test(error.message));
  await assert.rejects(publishedGraphPath(f.state,f.id,budget),error=>error?.code==='ENOENT');
  const db=new DatabaseSync(graphCheckpointPath(f.state,f.id,budget),{readOnly:true});try{const row=db.prepare('SELECT state,failure_kind,failure_reason FROM graph_builds').get();assert.equal(row.state,'error');assert.equal(row.failure_kind,'transient');assert.match(row.failure_reason,/disk full/);}finally{db.close();}
  const recovered=await SqliteCodeGraph.open(f.store,{budget});assert.ok(recovered.metrics.resumedFiles>0);assert.ok(recovered.metrics.resumedResolutionFiles>0);assert.equal(recovered.metrics.extractedFiles,0);assert.equal(recovered.metrics.resolvedFiles,0);recovered.graph.close();
});

test('a cache identity has one cold builder and concurrent readers see building explicitly',async t=>{
  const f=await fixture(t);const settled=await Promise.allSettled([SqliteCodeGraph.open(f.store),SqliteCodeGraph.open(f.store)]);
  assert.equal(settled.filter(result=>result.status==='fulfilled').length,1);const rejected=settled.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.reason instanceof GraphOpenError);assert.equal(rejected.reason.status,'building');
  for(const result of settled)if(result.status==='fulfilled')result.value.graph.close();
});

test('core scope is auditable and all scope uses an independent generation',async t=>{
  const f=await fixture(t,{'tests/test_hidden.py':'def hidden(): pass\n','examples/demo.py':'def demo(): pass\n'});
  const core=await SqliteCodeGraph.open(f.store);const corePage=await core.graph.lookup({snapshotId:f.id,query:'hidden',limit:5});
  assert.equal(corePage.items.length,0);assert.equal(core.metrics.coverage.totalLanguageFiles,3);assert.equal(core.metrics.coverage.indexedFiles,1);assert.equal(core.metrics.coverage.excludedTestFiles,1);assert.equal(core.metrics.coverage.excludedExampleFiles,1);assert.equal(corePage.generationState,'ready');assert.ok(corePage.warnings.some(value=>value.includes('intentionally excluded')));core.graph.close();
  const all=await SqliteCodeGraph.open(f.store,{scope:'all'});assert.equal((await all.graph.lookup({snapshotId:f.id,query:'hidden',limit:5})).items.length,1);assert.equal(all.metrics.coverage.indexedFiles,3);assert.equal(all.metrics.coverage.excludedTestFiles,0);
  assert.notEqual(await publishedGraphPath(f.state,f.id),await publishedGraphPath(f.state,f.id,undefined,'all'));all.graph.close();
});

test('v4 generation stores compact entities and aggregates repeated call sites',async t=>{
  const f=await fixture(t,{'a.py':'def save(): pass\ndef run():\n save()\n save()\n'});const opened=await SqliteCodeGraph.open(f.store);opened.graph.close();
  const db=new DatabaseSync(await publishedGraphPath(f.state,f.id),{readOnly:true});
  try{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));assert.ok(tables.has('entities'));assert.ok(tables.has('dependency_sites'));assert.ok(tables.has('relation_sites'));assert.equal(tables.has('symbols'),false);assert.equal(tables.has('sites'),false);
    for(const table of ['entities','relations','files']){const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);assert.equal(columns.includes('payload'),false);assert.equal(columns.includes('facts'),false);}
    const relation=db.prepare("SELECT site_count FROM relations WHERE kind='CALLS'").get();assert.equal(Number(relation.site_count),2);assert.equal(Number(db.prepare("SELECT count(*) n FROM relations WHERE kind='CALLS'").get().n),1);assert.equal(Number(db.prepare("SELECT count(*) n FROM relation_sites WHERE relation_id IN (SELECT relation_id FROM relations WHERE kind='CALLS')").get().n),2);
  }finally{db.close();}
});
