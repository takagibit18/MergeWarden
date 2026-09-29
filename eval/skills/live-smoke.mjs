import { readFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { ReviewEngine } from '../../src/engine/review.ts';
import { createOAuthModelRuntime,createPiRuntime } from '../../integrations/pi/src/runtime.ts';
import { runPiLearning } from '../../integrations/pi/src/learning.ts';
import { writeJson } from '../../src/infrastructure/files.ts';
import { readRun } from '../../src/engine/reports.ts';
const root=resolve(process.argv[2]),authPath=resolve(process.argv[3]);
const gate=JSON.parse(await readFile(join(root,'stage-a.json'),'utf8'));
if(gate.status!=='PASS')throw Error('Offline engineering gate must pass first');
const authorization=JSON.parse(await readFile(join(root,'authorization.json'),'utf8'));
if(authorization.reviewCallsMax<2||authorization.learningCallsMax<1)throw Error('Insufficient explicit authorization');
const fixture=JSON.parse(await readFile(join(root,'mechanism-smoke','receipt.json'),'utf8'));
const original=JSON.parse(await readFile(join(root,'mechanism-smoke','state','snapshots',fixture.manifest.snapshotId+'.json'),'utf8'));
const output=join(root,'live-smoke');await mkdir(output);
const model={provider:'openai-codex',modelId:'gpt-5.6-luna'},inference={thinkingLevel:'max',maxOutputTokens:32768};
const config={synthetic:true,qualityEvidence:false,reviewLimit:2,learningLimit:1,model,inference,authentication:'explicit dedicated Pi OAuth',firstAttemptOnly:true,timeoutMs:600000,maxToolCalls:100,providerHardOutputLimitVerified:false};
await writeJson(join(output,'config.json'),config);
const catalog=await createOAuthModelRuntime(model.provider,authPath),results=[];
const factory=options=>createPiRuntime(options,catalog,{extensions:[],firstAttemptOnly:true,preserveRouting:true});
for(let ordinal=1;ordinal<=2;ordinal++) {
 const path=join(output,'attempt-'+ordinal+'.json');await writeJson(path,{ordinal,status:'started',startedAt:new Date().toISOString()});const started=performance.now();
 try {
  const result=await new ReviewEngine(factory,undefined,ordinal===1?runPiLearning(catalog,true):undefined).run({repositoryPath:original.repositoryPath,stateDir:join(output,'state'),input:original.input,model,inference,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,skills:'auto',learn:ordinal===1?'auto':'off',evaluation:{tools:'text+graph',contextCwd:join(output,'runtime-context')}});
  const manifest=result.kind==='report'?await readRun(join(output,'state'),result.runId):null;
  const record={ordinal,result,manifest,elapsedMs:performance.now()-started};results.push(record);await writeJson(path,record);console.log(JSON.stringify({ordinal,status:result.kind==='report'?result.report.status:result.kind,learning:result.learning,runId:result.runId}));
  if(result.kind!=='report'||result.report.status==='failed')break;
 }catch {const record={ordinal,status:'failed',error:'Inspect preserved native artifacts; no automatic retry',elapsedMs:performance.now()-started};results.push(record);await writeJson(path,record);break;}
}
await writeJson(join(output,'results.json'),{...config,started:results.length,results});
