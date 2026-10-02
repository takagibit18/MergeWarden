import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createModelRuntime, createPiRuntime } from '../src/runtime.ts';
import { PiSessionJournal } from '../src/journal.ts';
import { ReviewController } from '../../../src/application/review-controller.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { readReport } from '../../../src/engine/reports.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { snapshot } from '../../../tests/helpers.mjs';
const require = createRequire(import.meta.url);
const { createAssistantMessageEventStream } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
async function fixture(t) {
  const parent = resolve(tmpdir()); const dir = await mkdtemp(join(parent, 'mergewarden-durable-'));
  t.after(async () => { assert.ok(resolve(dir).startsWith(parent + sep)); await rm(dir, {recursive:true,force:true}); });
  const repository = join(dir,'repo'); const state = join(dir,'state'); await mkdir(repository); await mkdir(state); return {repository,state};
}
async function syntheticRuntime(script) {
  const runtime = await createModelRuntime('fixture','offline-key'); let turn=0;
  runtime.registerProvider('fixture', { api:'openai-completions', baseUrl:'https://offline.invalid', apiKey:'offline-key',
    models:[{id:'offline',name:'Offline fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1024}],
    streamSimple(model,context) {
      const stream = createAssistantMessageEventStream(); const content=script(++turn,context);
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',
        usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:'start',partial:message}); stream.push({type:'done',reason:message.stopReason,message});}); return stream;
    } }); return runtime;
}
const call=(name,args,id)=>[{type:'toolCall',id:'call-'+id,name,arguments:args}];

test('exclusive empty native session persists business events before any assistant reply', async t=>{
  const {repository,state}=await fixture(t); const file=join(state,'session.jsonl'); closeSync(openSync(file,'wx',0o600));
  const manager=SessionManager.open(file,state,repository); const journal=new PiSessionJournal(manager,{durable:true});
  await new ReviewController(journal,'fixture-run',snapshot).start('final_only',['fixture.py']);
  const restored=new ReviewController(new PiSessionJournal(SessionManager.open(file),{durable:true}),'fixture-run',snapshot); await restored.restore();
  assert.equal(restored.state.status,'reviewing'); assert.deepEqual(manager.buildSessionContext().messages,[]);
  assert.equal((await readFile(file,'utf8')).trim().split('\n').length,2);
});

test('durable journal detects a truncated native log and stays poisoned',async t=>{
  const {repository,state}=await fixture(t); const file=join(state,'session.jsonl'); closeSync(openSync(file,'wx',0o600));
  const manager=SessionManager.open(file,state,repository); let failures=0;
  const journal=new PiSessionJournal(manager,{durable:true,onFailure:()=>failures++}); journal.checkpoint();
  await writeFile(file,'{"broken":'); assert.throws(()=>journal.checkpoint(),/persistence failed/);
  await writeFile(file,JSON.stringify(manager.getHeader())+'\n'); assert.throws(()=>journal.checkpoint(),/persistence failed/); assert.equal(failures,1);
});

test('real Pi loop executes only frozen-source tools and delivers a report entirely offline',async t=>{
  const f=await repositoryFixture(t); const head=await f.change();
  await f.write('AGENTS.md','UNTRUSTED_MARKER');
  let seenContext;
  const runtime=await syntheticRuntime((turn,context)=>{
    seenContext=context;
    if(turn===1) return call('read_diff',{path:'app.py'},turn);
    if(turn===2) return call('submit_review',{summary:'Synthetic SDK loop; no quality evaluation.',reviewedPaths:['app.py'],findings:[]},turn);
    return [{type:'text',text:'Done.'}];
  });
  const originalFetch=globalThis.fetch; globalThis.fetch=async()=>{throw Error('Network forbidden');}; t.after(()=>{globalThis.fetch=originalFetch;});
  const result=await new ReviewEngine(options=>createPiRuntime(options,runtime)).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text-only'}});
  assert.equal(result.report.status,'completed'); assert.deepEqual(await readReport(f.state,result.runId),result.report);
  assert.doesNotMatch(seenContext.systemPrompt,/UNTRUSTED_MARKER/); assert.deepEqual(seenContext.tools.map(t=>t.name).sort(),['read_diff','read_source','search_text','submit_review']);
  const rows=(await readFile(join(f.state,'runs',result.runId,'session.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.findIndex(r=>r.customType==='mergewarden.review-event.v1')<rows.findIndex(r=>r.type==='message' && r.message.role==='assistant'));
  assert.ok(rows.some(r=>r.type==='message' && r.message.role==='toolResult'));
});

test('native message write failure stops the Pi loop before executing its tool',async t=>{
  const {repository,state}=await fixture(t); let executed=0; let moved=false;
  const runtime=await syntheticRuntime(()=>call('read_source',{},1));
  const original=runtime.streamSimple.bind(runtime);
  runtime.streamSimple=(...args)=>{
    // Synchronous filesystem fault at the first actual model request.
    if(!moved) { moved=true; const fs=require('node:fs'); fs.renameSync(join(state,'session.jsonl'),join(state,'saved.jsonl')); fs.mkdirSync(join(state,'session.jsonl')); }
    return original(...args);
  };
  const review=await createPiRuntime({repositoryPath:repository,stateDir:state,runDir:state,model:{provider:'fixture',modelId:'offline'},tools:[{name:'read_source',description:'fixture',schema:{type:'object',properties:{}},async execute(){executed++;return {};}}]},runtime);
  t.after(()=>review.dispose());
  await assert.rejects(review.prompt('offline persistence fault',new AbortController().signal),/persistence failed/);
  assert.equal(executed,0); await assert.rejects(review.journal.readActiveBranch(),/persistence failed/);
});
