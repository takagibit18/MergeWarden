import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createModelRuntime, createPiRuntime } from '../src/runtime.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { BASE_SYSTEM_PROMPT, GRAPH_CAPABILITY_PROMPT, NAVIGATION_POLICY_PROMPT } from '../../../src/engine/prompt.ts';
import { sha256 } from '../../../src/infrastructure/files.ts';
const { createAssistantMessageEventStream }=await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
async function provider(script) {
 const runtime=await createModelRuntime('fixture','offline');let turn=0;
 runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{id:'offline',name:'offline',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1024}],streamSimple(model,context){
  const stream=createAssistantMessageEventStream();let content;try{content=script(++turn,context);}catch(error){console.error(error);throw error;}const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;
 }}); return runtime;
}
const call=(name,args)=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args}];
const result=c=>JSON.parse(c.messages.filter(m=>m.role==='toolResult').at(-1).content[0].text);
test('real Pi loop navigates graph, verifies frozen source and submits final source evidence',async t=>{
 const f=await repositoryFixture(t,{'app.py':'def ratio(total,count):\n return total / max(count,1)\n','client.py':'from app import ratio\ndef run(): return ratio(10,0)\n'});const head=await f.change();let graphPage;let source;
 const runtime=await provider((turn,c)=>{
  assert.equal(c.systemPrompt.split('\nCurrent working directory:')[0],BASE_SYSTEM_PROMPT+'\n'+NAVIGATION_POLICY_PROMPT+'\n'+GRAPH_CAPABILITY_PROMPT);
  assert.deepEqual(c.tools.map(t=>t.name).sort(),['graph_lookup','graph_neighbors','read_diff','read_source','search_text','submit_review']);
  const descriptions=Object.fromEntries(c.tools.map(t=>[t.name,t.description]));
  for(const name of ['graph_lookup','graph_neighbors']){assert.match(descriptions[name],/callers|references/i);assert.match(descriptions[name],/untouched|relevant code/i);assert.match(descriptions[name],/read_source/);}
  if(turn===1)return call('graph_lookup',{query:'ratio',limit:10});
  if(turn===2){graphPage=result(c);assert.equal(graphPage.status,'ok');return call('graph_neighbors',{symbolId:graphPage.items[0].id,relation:'CALLS',direction:'incoming',limit:10});}
  if(turn===3){assert.equal(result(c).items[0].sourcePath,'client.py');return call('read_diff',{path:'app.py'});}
  if(turn===4)return call('submit_review',{summary:'Attempt to bypass source read',reviewedPaths:['app.py'],findings:[{id:'zero',title:'Zero division',claim:'count=0 raises',trigger:'client.run()',impact:'request fails',severity:'high',evidence:[{snapshotId:graphPage.snapshotId,revision:'head',path:'app.py',startLine:1,endLine:2,contentSha256:sha256('def ratio(total, count):\n    return total / count')}]}]});
  if(turn===5){const rejected=c.messages.filter(m=>m.role==='toolResult').at(-1);assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected.content),/read_source/);return call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2});}
  if(turn===6){source=result(c);const {snapshotId,revision,path,startLine,endLine,contentSha256}=source;return call('submit_review',{summary:'Synthetic SDK integration, not quality measurement',reviewedPaths:['app.py'],findings:[{id:'zero',title:'Zero division',claim:'count=0 raises',trigger:'client.run()',impact:'request fails',severity:'high',evidence:[{snapshotId,revision,path,startLine,endLine,contentSha256}]}]});}
  return [{type:'text',text:'Done'}];
 });
 const r=await new ReviewEngine(o=>createPiRuntime(o,runtime)).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'}});
 assert.equal(r.report.status,'completed');assert.equal(r.report.findings.length,1);assert.equal(r.report.snapshot.id,graphPage.snapshotId);
 const m=JSON.parse(await readFile(join(f.state,'runs',r.runId,'run.json'),'utf8'));assert.equal(m.metrics.graphToolCalls,2);assert.ok(m.metrics.graph.buildMs>0);assert.equal(m.metrics.graph.warmRequestMs.length,1);
});
test('text-only SDK path uses frozen prompt and never opens a graph index',async t=>{
 const f=await repositoryFixture(t);const head=await f.change();await mkdir(join(f.state,'graphs'));
 const runtime=await provider((turn,c)=>{const prompt=c.systemPrompt.split('\nCurrent working directory:')[0];assert.equal(prompt,BASE_SYSTEM_PROMPT);for(const name of ['graph_lookup','graph_neighbors','search_entity','traverse_graph'])assert.ok(!prompt.includes(name));assert.deepEqual(c.tools.map(t=>t.name).sort(),['read_diff','read_source','search_text','submit_review']);if(turn===1)return call('read_diff',{path:'app.py'});if(turn===2)return call('submit_review',{summary:'offline',reviewedPaths:['app.py'],findings:[]});return [{type:'text',text:'Done'}];});
 const r=await new ReviewEngine(o=>createPiRuntime(o,runtime)).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text-only'}});assert.equal(r.report.status,'completed');assert.deepEqual(await readdir(join(f.state,'graphs')),[]);
});
