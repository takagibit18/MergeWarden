import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ReviewEngine} from '../src/engine/review.ts';
import {MemoryJournal} from '../src/adapters/memory-journal.ts';
import {repositoryFixture} from './repository-fixture.mjs';
const runtime=script=>async options=>({journal:new MemoryJournal(),async prompt(_text,signal){await script(Object.fromEntries(options.tools.map(t=>[t.name,t.execute])),signal);},async abort(){},dispose(){},usage(){return {input:0,output:0,total:0};}});
async function setup(t){const f=await repositoryFixture(t),head=await f.change();return {...f,options:{repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text+locagent'}}};}
test('G1 build failure is diagnostic when text fallback completes',async t=>{
 const f=await setup(t);await writeFile(join(f.state,'graphs'),'block index creation');const r=await new ReviewEngine(runtime(async tools=>{assert.equal((await tools.search_entity({searchTerms:['ratio'],topK:3})).status,'error');await tools.search_text({revision:'head',query:'ratio'});await tools.read_diff({path:'app.py'});await tools.submit_review({summary:'offline fallback',reviewedPaths:['app.py'],findings:[]});})).run(f.options);assert.equal(r.report.status,'completed');assert.match(r.report.summary,/navigation was degraded/i);const m=JSON.parse(await (await import('node:fs/promises')).readFile(join(f.state,'runs',r.runId,'run.json'),'utf8'));assert.deepEqual(m.metrics.navigation,{attempted:true,degraded:true,errors:1});
});
test('G1 cancellation terminates worker and delivers cancelled',async t=>{
 const f=await setup(t),abort=new AbortController();const r=await new ReviewEngine(runtime(async tools=>{const request=tools.search_entity({searchTerms:['ratio'],topK:3});setTimeout(()=>abort.abort(),10);await assert.rejects(request);})).run({...f.options,signal:abort.signal});assert.equal(r.report.status,'cancelled');
});
