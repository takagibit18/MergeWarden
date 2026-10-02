// Persistent synthetic SDK acceptance fixture; never included in PR quality numbers.
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedState,writeJson } from '../../src/infrastructure/files.ts';
import { ReviewEngine } from '../../src/engine/review.ts';
import { readReport,readRun } from '../../src/engine/reports.ts';
import { SkillBank } from '../../src/skills/bank.ts';
import { createModelRuntime,createPiRuntime } from '../../integrations/pi/src/runtime.ts';
import { runPiLearning } from '../../integrations/pi/src/learning.ts';
const {createAssistantMessageEventStream}=await import(new URL('../../integrations/pi/node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.url));
const output=await isolatedState(resolve(process.argv[2]),fileURLToPath(new URL('../..',import.meta.url))),repository=join(output,'checkout'),state=join(output,'state');
await mkdir(repository);await mkdir(state);
const exec=promisify(execFile),git=async args=>(await exec('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',repository,...args],{windowsHide:true})).stdout.trim();
await git(['init']);await writeFile(join(repository,'app.py'),'def ratio(total, count):\n    return total / max(count, 1)\n');await git(['add','.']);await git(['commit','-m','synthetic base']);const base=await git(['rev-parse','HEAD']);
await writeFile(join(repository,'app.py'),'def ratio(total, count):\n    return total / count\n');await git(['add','.']);await git(['commit','-m','synthetic changed input']);const head=await git(['rev-parse','HEAD']);
async function scripted(script){const runtime=await createModelRuntime('fixture','offline-key');let turn=0;runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline-key',models:[{id:'offline',name:'Scripted fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}],streamSimple(model,context){const content=script(context,++turn),stream=createAssistantMessageEventStream(),message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;}});return runtime;}
const call=(name,args,n)=>[{type:'toolCall',id:'call-'+n,name,arguments:args}];
const factory=async options=>createPiRuntime(options,await scripted((context,turn)=>{
 const loaded=options.skillsEnabled,offset=loaded?1:0;
 if(loaded&&turn===1)return call('read_review_skill',{id:'sk_denominator'},turn);
 if(turn===1+offset)return call('read_diff',{path:'app.py'},turn);
 if(loaded&&turn===3)return call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2},turn);
 if(turn===(loaded?4:2)) {
  const source=loaded?context.messages.filter(m=>m.role==='toolResult').map(m=>JSON.parse(m.content[0].text)).find(m=>m._mergewarden?.evidenceRefId):undefined;
  return call('submit_review',{summary:'Synthetic SDK acceptance only',reviewedPaths:['app.py'],findings:source?[{id:'zero',title:'Division by zero',claim:'The guard was removed.',trigger:'count=0',impact:'ZeroDivisionError',severity:'high',evidence:[{evidenceRefId:source._mergewarden.evidenceRefId}]}]:[]},turn);
 }
 return [{type:'text',text:'Done'}];
}));
const model={provider:'fixture',modelId:'offline'},learner=runPiLearning(await scripted(context=>{const m=context.messages[0].content,input=JSON.parse(typeof m==='string'?m:m.filter(c=>c.type==='text').map(c=>c.text).join(''));return [{type:'text',text:JSON.stringify({operations:[{op:'add',id:'sk_denominator',expectedRevision:0,sourceIds:[input.source.id],reason:'Synthetic fixture procedure',content:{type:'review_procedure',title:'Check explicit denominator input',conditions:['When callers may pass zero.'],steps:['Read caller constraints for count.','Check changed division guards with those constraints.'],counterexamples:['Validated positive count excludes zero.'],stopConditions:['Stop once current source establishes the permitted input range.'],paths:['app.py'],languages:['Python'],keywords:['count'],dependencies:[]}}]})}];}));
const options={repositoryPath:repository,stateDir:state,input:{kind:'commits',base,head},model,evaluation:{tools:'text-only'},skills:'auto',learn:'auto'};
const first=await new ReviewEngine(factory,undefined,learner).run(options);const second=await new ReviewEngine(factory).run({...options,learn:'off'});
if(first.learning?.status!=='applied'||second.report.status!=='completed'||second.report.findings.length!==1)throw Error('Offline mechanism gate failed');
await readReport(state,first.runId);await readReport(state,second.runId);const skills=await new SkillBank(state).skills();
const receipt={synthetic:true,qualityEvidence:false,firstRun:first.runId,learning:first.learning,skills,nextRun:second.runId,manifest:await readRun(state,second.runId),reads:JSON.parse(await readFile(join(state,'runs',second.runId,'skill-reads.json'),'utf8')),sourceEvidence:second.report.findings[0].evidence};
await writeJson(join(output,'receipt.json'),receipt);console.log(JSON.stringify(receipt,null,2));
