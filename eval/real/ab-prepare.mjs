import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {verifyBundle} from './admission.mjs';
import {RealCorpusAdapter} from './cache.mjs';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {SqliteCodeGraph,publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {isolatedState,writeJson,sha256} from '../../src/infrastructure/files.ts';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {resolveModelPolicy} from '../../integrations/pi/src/model-policy.ts';
import {digest} from './open-label.mjs';
import {root,model,inference,pairedPlan,codeReceipt,read,referenceRun} from './ab-contract.mjs';
import {ReviewBudget} from '../../src/engine/budget.ts';
const output=await isolatedState(resolve(process.argv[2]),root),cache=resolve(process.argv[3]);
const corpus=join(root,'eval/real/corpora/mergewarden-real-python40-v1');
try{await read(join(output,'experiment.json'));throw Error('Experiment already frozen');}catch(e){if(e.code!=='ENOENT')throw e;}
const {lock,data}=await verifyBundle(corpus,{publicOnly:true});
const tasks=data['public/tasks.jsonl'];assert.equal(tasks.length,40);
const catalog=await createModelRuntime(),selected=catalog.getModel(model.provider,model.modelId),policy=resolveModelPolicy(selected,inference);
const adapter=new RealCorpusAdapter({cache,stateDir:join(output,'state'),configuration:{...model,policy:'final_only',promptVersion:1}}),cases=[];
const prepareOnly=process.argv.includes('--prepare-only'),from=prepareOnly?Number(process.argv[process.argv.indexOf('--from')+1]):0,through=prepareOnly?Number(process.argv[process.argv.indexOf('--through')+1]):tasks.length;
assert(Number.isSafeInteger(from)&&Number.isSafeInteger(through)&&from>=0&&through<=tasks.length&&from<through,'Invalid preparation range');
await mkdir(join(output,'prepared'),{recursive:true});
for(const [index,task] of tasks.entries()){
 if(index<from||index>=through)continue;
 const receiptPath=join(output,'prepared',task.case_id+'.json');let c;
 try{c=await read(receiptPath);assert.equal(c.taskSha256,digest(task));const store=await SnapshotStore.load(join(output,'state'),c.snapshotId);const hot=await SqliteCodeGraph.openPublishedOnly(store,{scope:'core'});hot.graph.close();assert.equal(hot.manifest.generationId,c.generationId);}
 catch(e){if(e.code!=='ENOENT')throw e;
  console.log(JSON.stringify({event:'preparing',index:index+1,caseId:task.case_id,repository:task.repository}));
  const {repositoryPath,store}=await adapter.materialize(task,{offline:true});
  let coverageTools=0;for(const path of store.manifest.changedPaths){let cursor=0;do{const page=await store.diff(path,cursor,200);coverageTools++;if(!page.truncated)break;cursor=page.nextCursor;}while(true);}
  const start=performance.now(),built=await SqliteCodeGraph.open(store,{scope:'core'});built.graph.close();const preparationMs=performance.now()-start;
  const hot=await SqliteCodeGraph.openPublishedOnly(store,{scope:'core'});hot.graph.close();
  const seedId='00000000-0000-4000-8000-'+String(index+1).padStart(12,'0');
  await writeJson(join(output,'state/runs',seedId,'run.json'),referenceRun(seedId,store.manifest.identity.id));
  c={caseId:task.case_id,taskSha256:digest(task),repositoryPath,snapshotId:store.manifest.identity.id,seedId,changedPaths:store.manifest.changedPaths,minimumCoverageCalls:coverageTools,snapshotSha256:sha256(await readFile(join(output,'state/snapshots',store.manifest.identity.id+'.json'))),generationId:hot.manifest.generationId,generationState:hot.manifest.generationState,graphSha256:sha256(await readFile(await publishedGraphPath(join(output,'state'),store.manifest.identity.id))),coverage:hot.manifest.coverage,preparationMs,preparationMetrics:built.metrics};
  await writeJson(receiptPath,c);
 }
 cases.push(c);console.log(JSON.stringify({event:'prepared',index:index+1,caseId:c.caseId,coverageCalls:c.minimumCoverageCalls,generationState:c.generationState}));
}
if(prepareOnly){console.log(JSON.stringify({event:'preparation_range_complete',from,through}));process.exit(0);}
const minCalls=cases.map(c=>c.minimumCoverageCalls).sort((a,b)=>a-b),maxTools=Math.max(100,minCalls.at(-1)+30,2*minCalls[Math.ceil(minCalls.length*.9)-1]);assert(maxTools<=1000);
const identity={schemaVersion:1,protocol:'gpt-paired-ab-1',kind:'formal',attemptPolicy:'first_attempt',readiness:'STAGED_USER_AUTHORIZED',outputDirectory:output,model,inference,modelCapability:policy.configuration,modelApi:selected.api,modelBaseUrl:selected.baseUrl,timeoutMs:600000,maxTools,outputTokenLimitEnforced:false,corpusId:lock.corpusId,corpusSha256:lock.corpusSha256,tasks,cases,plan:pairedPlan(tasks),checkpointPairs:10,code:await codeReceipt(),arms:{A:'text-only',B:'automatic pi_structural_v1 + dispatch_v2'},rules:{repeat:1,providerRetries:0,agentRetries:0,autoCompaction:false,graphMode:'prepared_only',privateLabels:false,preRegisteredTargets:false,selection:'entire frozen public 40, original order',checkpoint:'Pause after 10 complete pairs; review mechanics and traces before remaining pairs; no retuning or replacing first attempts.',quality:'Anonymous adjudication after predictions; existing Agent-labeled previously used corpus, not fresh independent human gold.'}};
identity.protocol='gpt-paired-ab-2';
identity.budgetPolicy=new ReviewBudget({limit:maxTools,timeoutMs:identity.timeoutMs,started:0,used:()=>0,now:()=>0}).state();
identity.experimentSha256=digest(identity);await writeFile(join(output,'experiment.json'),JSON.stringify(identity,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({event:'frozen',pairs:40,maxTools,output}));
