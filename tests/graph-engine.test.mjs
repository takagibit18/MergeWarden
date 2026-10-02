import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { repositoryFixture } from './repository-fixture.mjs';
import { sha256 } from '../src/infrastructure/files.ts';
const runtime=script=>async options=>({journal:new MemoryJournal(),async prompt(text,signal){await script(Object.fromEntries(options.tools.map(t=>[t.name,t.execute])),signal,text,options.tools);},async abort(){},dispose(){},usage(){return {input:0,output:0,total:0};}});
async function setup(t){const f=await repositoryFixture(t);const head=await f.change();return {...f,options:{repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'}}};}
const manifest=async(f,r)=>JSON.parse(await readFile(join(f.state,'runs',r.runId,'run.json'),'utf8'));
const breakGraph=f=>writeFile(join(f.state,'graphs'),'block index creation');
test('graph error plus text/source fallback can complete with a valid finding',async t=>{
 const f=await setup(t);await breakGraph(f);let fallback;
 const r=await new ReviewEngine(runtime(async tools=>{const page=await tools.graph_lookup({query:'ratio',limit:10});assert.equal(page.status,'error');await tools.search_text({revision:'head',query:'ratio'});await tools.read_diff({path:'app.py'});fallback=await tools.read_source({revision:'head',path:'app.py',startLine:1,endLine:2});await tools.submit_review({summary:'fallback finding',reviewedPaths:['app.py'],findings:[{id:'zero',title:'Zero division',claim:'count=0 raises',trigger:'ratio(1, 0)',impact:'request fails',severity:'high',evidence:[{snapshotId:fallback.snapshotId,revision:fallback.revision,path:fallback.path,startLine:fallback.startLine,endLine:fallback.endLine,contentSha256:fallback.contentSha256}]}]});})).run(f.options);
 assert.equal(r.report.status,'completed');assert.equal(r.report.findings.length,1);assert.match(r.report.summary,/navigation was degraded/i);assert.deepEqual((await manifest(f,r)).metrics.navigation,{attempted:true,degraded:true,errors:1});
});
test('graph error plus text fallback can complete a zero-finding review',async t=>{
 const f=await setup(t);await breakGraph(f);const r=await new ReviewEngine(runtime(async tools=>{assert.equal((await tools.graph_lookup({query:'ratio',limit:10})).status,'error');await tools.search_text({revision:'head',query:'ratio'});await tools.read_diff({path:'app.py'});await tools.submit_review({summary:'no findings after fallback',reviewedPaths:['app.py'],findings:[]});})).run(f.options);
 assert.equal(r.report.status,'completed');assert.match(r.report.summary,/navigation was degraded/i);assert.equal((await manifest(f,r)).metrics.navigation.degraded,true);
});
test('graph error without final submission remains partial',async t=>{
 const f=await setup(t);await breakGraph(f);const r=await new ReviewEngine(runtime(async tools=>{assert.equal((await tools.graph_lookup({query:'ratio',limit:10})).status,'error');await tools.read_diff({path:'app.py'});})).run(f.options);assert.equal(r.report.status,'partial');assert.match(r.report.summary,/final submission or coverage/i);
});
test('graph error followed by timeout remains partial',async t=>{
 const f=await setup(t);await breakGraph(f);const r=await new ReviewEngine(runtime(async tools=>{assert.equal((await tools.graph_lookup({query:'ratio',limit:10})).status,'error');await new Promise(()=>{});})).run({...f.options,timeoutMs:5000});assert.equal(r.report.status,'partial');assert.match(r.report.summary,/time budget exhausted/i);
});
test('text-only completion remains unchanged and records no navigation attempt',async t=>{
 const f=await setup(t);const r=await new ReviewEngine(runtime(async(tools,_signal,prompt,definitions)=>{assert.deepEqual(Object.keys(tools).sort(),['read_diff','read_source','search_text','submit_review']);assert.match(prompt,/available repository-navigation tools/);assert.ok(definitions.find(x=>x.name==='search_text').description.includes('Literal search'));await tools.read_diff({path:'app.py'});await tools.submit_review({summary:'text only',reviewedPaths:['app.py'],findings:[]});})).run({...f.options,evaluation:{tools:'text-only'}});assert.equal(r.report.status,'completed');assert.deepEqual((await manifest(f,r)).metrics.navigation,{attempted:false,degraded:false,errors:0});
});
test('graph id and even a computed source hash cannot bypass read_source evidence',async t=>{
 const f=await setup(t);const r=await new ReviewEngine(runtime(async tools=>{const diff=await tools.read_diff({path:'app.py'});const candidate={id:'x',title:'x',claim:'x',trigger:'x',impact:'x',severity:'high',evidence:[{snapshotId:diff.snapshotId,revision:'head',path:'app.py',startLine:1,endLine:2,contentSha256:sha256('def ratio(total, count):\n    return total / count')}]};await assert.rejects(tools.submit_review({summary:'x',reviewedPaths:['app.py'],findings:[candidate]}),/read_source/);candidate.evidence=[{snapshotId:diff.snapshotId,nodeId:'graph-node'}];await assert.rejects(tools.submit_review({summary:'x',reviewedPaths:['app.py'],findings:[candidate]}),/revision/);await tools.submit_review({summary:'offline',reviewedPaths:['app.py'],findings:[]});})).run(f.options);assert.equal(r.report.status,'completed');
});
test('graph cancellation terminates worker and delivers cancelled rather than clean',async t=>{
 const f=await setup(t);const abort=new AbortController();const r=await new ReviewEngine(runtime(async tools=>{const request=tools.graph_lookup({query:'ratio',limit:10});setTimeout(()=>abort.abort(),10);await assert.rejects(request);})).run({...f.options,signal:abort.signal});assert.equal(r.report.status,'cancelled');
});
