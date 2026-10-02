import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModelRuntime,createPiRuntime} from '../src/runtime.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {BASE_SYSTEM_PROMPT,NAVIGATION_POLICY_PROMPT} from '../../../src/engine/prompt.ts';
import {LOCAGENT_CAPABILITY_PROMPT} from '../../../src/experiments/locagent/contracts.ts';
import {analyzeRetrieval} from '../../../src/experiments/locagent/traces.ts';
import {sha256} from '../../../src/infrastructure/files.ts';
const {createAssistantMessageEventStream}=await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
async function provider(script){const runtime=await createModelRuntime('fixture','offline');let turn=0;runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{id:'offline',name:'offline',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1024}],streamSimple(model,c){const stream=createAssistantMessageEventStream(),content=script(++turn,c),message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;}});return runtime;}
const call=(name,args)=>[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args}];
const last=c=>c.messages.filter(m=>m.role==='toolResult').at(-1);
const result=c=>JSON.parse(last(c).content[0].text);
const evidence=({snapshotId,revision,path,startLine,endLine,contentSha256})=>({snapshotId,revision,path,startLine,endLine,contentSha256});
test('Stage B real Pi: Search → Traverse → separate source → durable accepted evidence and attribution',async t=>{
 const f=await repositoryFixture(t,{'app.py':'def ratio(total,count):\n return total / max(count,1)\n','client.py':'from app import ratio\ndef run(): return ratio(10,0)\n'}),head=await f.change();let page,caller,source;
 const finding=ev=>({id:'zero',title:'Zero division',claim:'Zero count raises in caller',trigger:'client.run()',impact:'request fails',severity:'high',evidence:ev});
 const runtime=await provider((turn,c)=>{
  const prompt=c.systemPrompt.split('\nCurrent working directory:')[0];assert.equal(prompt,BASE_SYSTEM_PROMPT+'\n'+NAVIGATION_POLICY_PROMPT+'\n'+LOCAGENT_CAPABILITY_PROMPT);assert.ok(!prompt.includes('graph_lookup'));assert.ok(!prompt.includes('graph_neighbors'));
  assert.deepEqual(c.tools.map(t=>t.name).sort(),['read_diff','read_source','search_entity','search_text','submit_review','traverse_graph']);
  const descriptions=Object.fromEntries(c.tools.map(t=>[t.name,t.description]));
  for(const name of ['search_entity','traverse_graph']){assert.match(descriptions[name],/untouched|relevant code/i);assert.match(descriptions[name],/read_source/);}
  if(turn===1)return call('read_diff',{path:'app.py'});
  if(turn===2)return call('search_entity',{searchTerms:['app.ratio'],topK:3});
  if(turn===3){page=result(c);assert.equal(page.items[0].explorationOnly,undefined);assert.equal(page.explorationOnly,true);return call('traverse_graph',{startEntities:[page.items[0].entityId],direction:'upstream',maxHops:2,entityTypeFilter:[],relationTypeFilter:['CALLS'],maxNodes:10});}
  if(turn===4){assert.ok(result(c).tree.includes('client.py'));return call('submit_review',{summary:'Bypass attempt',reviewedPaths:['app.py'],findings:[finding([{snapshotId:page.snapshotId,revision:'head',path:'app.py',startLine:1,endLine:2,contentSha256:sha256('def ratio(total, count):\n    return total / count')}])]});}
  if(turn===5){assert.equal(last(c).isError,true);assert.match(JSON.stringify(last(c).content),/read_source/);return call('read_source',{revision:'head',path:'client.py',startLine:2,endLine:2});}
  if(turn===6){caller=evidence(result(c));return call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2});}
  if(turn===7){source=evidence(result(c));return call('submit_review',{summary:'Scripted plumbing check, not quality',reviewedPaths:['app.py'],findings:[finding([caller,source])]});}
  return [{type:'text',text:'Done'}];
 });
 const r=await new ReviewEngine(o=>createPiRuntime(o,runtime)).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text+locagent'}});
 assert.equal(r.report.status,'completed');assert.equal(r.report.findings.length,1);
 const jsonl=await readFile(join(f.state,'runs',r.runId,'session.jsonl'),'utf8');
 const trace=analyzeRetrieval({runKey:'script',snapshotId:page.snapshotId,findings:r.report.findings,jsonl});
 assert.deepEqual(trace.traceIssues.filter(i=>i.severity==='fatal'),[]);assert.equal(trace.findings[0].discoveryPath,'graph_assisted');assert.equal(trace.metrics.searchToTraverse,1);assert.equal(trace.metrics.novelEntityToSource,1);assert.equal(trace.sourceLinks[0].retrievalOrigin,'locagent_graph');
 const missing=jsonl.split('\n').filter(Boolean).map(line=>{const e=JSON.parse(line);if(e.message?.role==='assistant')delete e.message.usage;return JSON.stringify(e);}).join('\n');
 assert.equal(analyzeRetrieval({runKey:'missing',snapshotId:page.snapshotId,findings:[],jsonl:missing}).metrics.totalTokens,null);
});
