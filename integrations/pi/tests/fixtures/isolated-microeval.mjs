import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModelRuntime} from '../../src/runtime.ts';
import {ReviewEngine} from '../../../../src/engine/review.ts';
import {microRuntime} from '../../../../eval/microeval/runtime.mjs';
import {analyzeInvestigation} from '../../../../src/eval/provenance/investigation.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
assert(process.permission);assert.equal(process.permission.has('fs.read',input.deniedAncestor),false);
let requests=0,pack,runDir;
globalThis.fetch=async(url,init)=>{
 const body=await new Request(url,init).json();requests++;const call=(name,args)=>({name,args});let actions=[];
 if(requests===1)actions=[call('read_diff',{path:'app.py'})];
 else if(requests===2){assert(pack);const card=pack.investigations[0].candidateCatalog.find(c=>c.candidateRefId!==pack.sources[0].candidateRefId);assert(card);actions=[call('expand_structural_candidate',{candidateRefId:card.candidateRefId})];}
 else if(requests===3)actions=[call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2})];
 else if(requests===4){const refs=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).filter(r=>r._mergewarden?.evidenceRefId).map(r=>({evidenceRefId:r._mergewarden.evidenceRefId}));actions=[call('submit_review',{summary:'Offline isolated fixture',reviewedPaths:['app.py'],findings:[{id:'f',title:'Missing required argument',claim:'Caller supplies one argument',trigger:'caller()',impact:'TypeError',severity:'high',evidence:refs}]})];}
 const delta=actions.length?{role:'assistant',tool_calls:actions.map((a,i)=>({index:i,id:`isolated_${requests}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Done'};
 return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:input.config.model.modelId,choices:[{index:0,delta,finish_reason:actions.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
};
const modelRuntime=await createModelRuntime(input.config.model.provider,'offline-key');
const engine=new ReviewEngine(async options=>{runDir=options.runDir;return microRuntime(options,modelRuntime,{...input,arm:'B',onPackage:p=>{pack=p;},onExtensionError:e=>console.error(e)});});
const result=await engine.run({...input.options,model:input.config.model,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}});
assert.equal(result.report.status,'completed');const jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');
const attribution=analyzeInvestigation({runId:result.runId,snapshotId:input.case.snapshotId,findings:result.report.findings,jsonl});assert.equal(attribution.model_expanded_structural_assistance,1);assert.equal(attribution.packagesDelivered,1);
await writeFile(join(input.options.stateDir,'isolated-result.json'),JSON.stringify({status:'PASS',requests,realProviderRequests:0,ancestorReadDenied:true,attribution}));
