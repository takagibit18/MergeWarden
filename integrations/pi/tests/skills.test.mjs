import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createModelRuntime,createPiRuntime } from '../src/runtime.ts';
import { runPiLearning,LEARNING_PROMPT,LEARNING_PROMPT_VERSION,LEARNING_PROMPT_SHA256 } from '../src/learning.ts';
import { selectLearningContext } from '../../../src/skills/learning-context.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { SkillBank } from '../../../src/skills/bank.ts';
import { readRun,readReport } from '../../../src/engine/reports.ts';
const {createAssistantMessageEventStream}=await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
async function provider(script) {
 const runtime=await createModelRuntime('fixture','offline-key');let turn=0;
 runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline-key',models:[{id:'offline',name:'offline',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}],streamSimple(model,context){const stream=createAssistantMessageEventStream(),content=script(context,++turn);const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;}});return runtime;
}
const call=(name,args)=>[{type:'toolCall',id:'c-'+name,name,arguments:args}];
test('native learning preserves selected catalog/bodies and checks actual UTF-8 artifacts before one request',async t=>{
 const f=await repositoryFixture(t),directory=join(f.state,'aware');await mkdir(directory);const source={id:'run:fixture',repositoryKey:'repo:a',snapshotId:'a'.repeat(64),independenceKey:'b'.repeat(64)};
 const skills=Array.from({length:5},(_,i)=>({id:'sk_'+i,revision:1,repositoryKey:'repo:a',owner:'learner',state:'trial',sources:[],type:'review_procedure',scopeType:'review_method',title:'Inspect scoring',conditions:['When scoring changes'],steps:['Read callers','Inspect empty values'],counterexamples:['Caller validates input'],stopConditions:['Stop after verification'],paths:['app.py'],languages:['Python'],keywords:['score'],dependencies:[]}));
 const input=selectLearningContext({policy:'fixture',source,report:{summary:'score empty input'},sourcePages:[{path:'app.py',text:'score("边界")',fileHash:'c'.repeat(64)}],toolEvents:[],fixedRules:'Evidence rules remain fixed.',bankSnapshotId:'d'.repeat(64)},skills);const before=structuredClone(input);let calls=0;
 const runtime=await provider(context=>{calls++;const content=context.messages[0].content;const visible=JSON.parse(typeof content==='string'?content:content.filter(c=>c.type==='text').map(c=>c.text).join(''));assert.equal(visible.existingSkills.catalog.length,5);assert.equal(visible.relevantSkills.length,3);assert.equal(visible.existingSkills.catalog.filter(c=>c.bodyProvided).length,3);assert(visible.existingSkills.catalog.filter(c=>!c.bodyProvided).every(c=>c.readOnly));return [{type:'text',text:JSON.stringify({operations:[{op:'noop',reason:'Synthetic already-covered fixture'}]})}];});
 const options={directory,model:{provider:'fixture',modelId:'offline'},signal:new AbortController().signal};await runPiLearning(runtime)(input,options);assert.equal(calls,1);assert.deepEqual(input,before);
 const host=await readFile(join(directory,'input.json')),model=await readFile(join(directory,'model-input.json')),meta=JSON.parse(await readFile(join(directory,'learning-input-meta.json'),'utf8'));assert.equal(meta.inputBytes,host.byteLength);assert.equal(meta.modelInputBytes,model.byteLength);assert(meta.inputBytes<=40000&&meta.modelInputBytes<=40000&&meta.existingKnowledgeBytes<=12000);assert.equal(meta.promptVersion,LEARNING_PROMPT_VERSION);assert.equal(meta.promptSha256,LEARNING_PROMPT_SHA256);assert.equal(meta.bodyCount,3);
 const tooLarge={...input,fixedRules:'界'.repeat(14000)};await assert.rejects(runPiLearning(runtime)(tooLarge,{...options,directory:join(f.state,'never-started')}),/UTF-8 byte limit/);assert.equal(calls,1);
});
test('native Pi review → separate learning session → next review consumes frozen Skill and still reads source for evidence',async t=>{
 const f=await repositoryFixture(t),head=await f.change();await f.write('AGENTS.md','MALICIOUS_AMBIENT_MARKER');let learningCalls=0,observed,skillId;
 const learningRuntime=await provider(context=>{learningCalls++;assert.deepEqual(context.tools??[],[]);assert.ok(context.systemPrompt.startsWith(LEARNING_PROMPT));assert.doesNotMatch(context.systemPrompt,/MALICIOUS_AMBIENT_MARKER/);const input=JSON.parse(typeof context.messages[0].content==='string'?context.messages[0].content:context.messages[0].content.filter(c=>c.type==='text').map(c=>c.text).join(''));skillId='sk_'+input.newTargets[0].split('_')[1]+'_1';return [{type:'text',text:JSON.stringify({operations:[{op:'add',targetRef:input.newTargets[0],sourceRefs:[input.source.ref],reason:'Synthetic mechanism test',content:{type:'review_procedure',title:'Check explicit denominator inputs',conditions:['When count is supplied by a caller.'],steps:['Read call sites and inspect allowed count values.','Check division guards for explicit zero.'],counterexamples:['Positive validation excludes zero.'],stopConditions:['Stop after source establishes the allowed range.'],paths:['app.py'],languages:['Python'],keywords:['count'],scopeType:'review_method',symbols:[],dependencyRefs:[]}}]})}];});
 const factory=async options=>createPiRuntime(options,await provider((context,turn)=>{
   if(options.skillsEnabled){
     observed=context;
     if(turn===1)return call('read_review_skill',{id:skillId});
     if(turn===2){const body=JSON.parse(context.messages.find(m=>m.role==='toolResult').content[0].text);assert.equal(body.materialType,'review_skill');assert.equal(body.evidenceEligible,false);assert.equal(body._mergewarden.evidenceRefId,undefined);return call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2});}
     if(turn===3)return call('read_diff',{path:'app.py'});
     if(turn===4){const result=context.messages.filter(m=>m.role==='toolResult').map(m=>JSON.parse(m.content[0].text)).find(m=>m._mergewarden?.evidenceRefId);return call('submit_review',{summary:'Synthetic source evidence validation',reviewedPaths:['app.py'],findings:[{id:'division',title:'Zero count',claim:'Division can receive zero.',trigger:'count=0',impact:'exception',severity:'high',evidence:[{evidenceRefId:result._mergewarden.evidenceRefId}]}]});}
   }else{if(turn===1)return call('read_diff',{path:'app.py'});if(turn===2)return call('submit_review',{summary:'Original synthetic report',reviewedPaths:['app.py'],findings:[]});}
   return [{type:'text',text:'Done.'}];
 }));
 const options={repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text-only'},skills:'auto',learn:'auto'};
 const first=await new ReviewEngine(factory,undefined,runPiLearning(learningRuntime)).run(options);assert.equal(first.report.status,'completed');assert.equal(first.learning.status,'applied');assert.equal(learningCalls,1);
 const next=await new ReviewEngine(factory).run({...options,learn:'off'});assert.equal(next.report.status,'completed');assert.equal(next.report.findings.length,1);assert.deepEqual(await readReport(f.state,next.runId),next.report);assert.equal((await readRun(f.state,next.runId)).skills.available.length,1);assert.match(observed.systemPrompt,/fallible experience/);assert.doesNotMatch(observed.systemPrompt,/MALICIOUS_AMBIENT_MARKER/);
 const bank=new SkillBank(f.state),job=first.learning.jobs[0];const rows=(await readFile(join(bank.root,'attempts',job.id,'1','session.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(rows.some(r=>r.message?.role==='assistant'));assert.ok(rows.some(r=>r.message?.role==='user'));
 const reads=JSON.parse(await readFile(join(f.state,'runs',next.runId,'skill-reads.json'),'utf8'));assert.equal(reads.length,1);assert.equal(reads[0].ordinal,1);
});
test('native extraction format failure leaves original report delivered and records failed attempt, no repair loop',async t=>{
 const f=await repositoryFixture(t),head=await f.change();let calls=0;
 const runtime=await provider(()=>{calls++;return [{type:'text',text:'not structured JSON'}];});
 const factory=async options=>createPiRuntime(options,await provider((_context,turn)=>turn===1?call('read_diff',{path:'app.py'}):turn===2?call('submit_review',{summary:'Synthetic',reviewedPaths:['app.py'],findings:[]}):[{type:'text',text:'Done'}]));
 const result=await new ReviewEngine(factory,undefined,runPiLearning(runtime)).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text-only'},learn:'auto'});
 assert.equal(calls,1);assert.equal(result.learning.status,'failed');assert.equal(result.report.status,'completed');assert.equal((await readRun(f.state,result.runId)).status,'delivered');assert.equal((await new SkillBank(f.state).skills()).length,0);
});
