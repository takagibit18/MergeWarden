import assert from 'node:assert/strict';
import {join,resolve,relative,dirname} from 'node:path';
import {readFile,copyFile,mkdir,constants,access} from 'node:fs/promises';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {publishedGraphPath,graphPublishPath} from '../../src/graph/sqlite-store.ts';
import {buildUnits} from '../intent-router/input.mjs';
import {legalPlans} from '../intent-router/contracts.mjs';
import {graphData} from '../frontier-data.mjs';
import {EXPERIMENT,read,save,hash,identity,publicPrefix,publicPrompt,probe,targetInCatalog} from './common.mjs';
const out=resolve(process.argv[2]),root=dirname(out),shadow=join(root,'changeunit-semantic-intent-shadow-20260926'),old=join(root,'full-context-candidate-dataset-20260925');
assert.equal((await readFile(join(out,'baseline-exit.txt'),'utf8')).trim(),'0');
const universe=await read(join(shadow,'universe.json')),privateMaterial=await read(join(root,'real-route-recall-diagnostic-20260925/phase-b/private-material.json'));
const selected=[],admission=[],privateTargets=[];
for(const [id,alias] of [['D1','SR05'],['C1','SR18']]){
 const prior=universe.primary.find(c=>c.alias===alias),stored=await read(join(shadow,'phase-a/change-units',alias+'.json'));
 const c={id,caseId:prior.caseId,snapshotId:prior.snapshotId,state:prior.state,generationId:prior.generationId,graphSha256:prior.graphIdentity.sha256,snapshotSha256:prior.snapshotIdentity.sha256,changedPaths:prior.changedPaths,unit:stored.units[0],intent:'RELATIONSHIP_CHECK'};
 const prefix=publicPrefix(await read(join(shadow,'phase-a/prefixes',alias+'.json'))),target=privateMaterial.find(x=>x.caseId===prior.caseId);
 assert(target);assert.equal(target.label,id==='D1'?'defect':'clean');
 const targets=target.requiredUntouched??[];const a=await probe(c,prefix),b=await probe(c,prefix);assert.equal(hash(a),hash(b));if(id==='D1')assert(targetInCatalog(a.pack,targets));
 selected.push({c,prefix,execution:a});privateTargets.push({id,caseId:c.caseId,snapshotId:c.snapshotId,label:target.label,targets,sourceMaterial:target});
 admission.push({id,caseId:c.caseId,status:'ADMITTED',catalogItems:a.pack.investigations[0].candidateCatalog.length,reason:id==='D1'?'Previously actionable CU01 + RELATIONSHIP_CHECK; current shared dispatch confirmed.':'Frozen Requests clean connection-close fix; public Request.send change reasonably warrants relationship inspection. Selected before any model request.'});
}
const historic=(await read(join(old,'universe.json'))).plans.find(c=>c.caseId==='derived-RG2-8a20ce3c59fd');assert(historic);
const oldPrefix=await read(join(old,'phase-a/review-contexts',historic.caseId+'.json'));
const d2Prefix=publicPrefix({snapshotId:historic.snapshotId,changedPaths:historic.changedPaths,observations:oldPrefix.blocks.map(b=>({toolName:b.tool,input:b.input,result:b.result}))});
const material=privateMaterial.find(x=>x.caseId===historic.sourceCaseId);assert(material);
// D2 uses its existing full-context D3 target definition, not a later route-audit
// navigation range that straddles two declarations (600..615).
const historicTarget=(await read(join(old,'dataset-final/primary-cases.json'))).find(c=>c.sourceCaseId===historic.sourceCaseId);
assert.equal(historicTarget.snapshotId,historic.snapshotId);
const d2Store=await SnapshotStore.load(historic.state,historic.snapshotId),d2Targets=[];
for(const t of historicTarget.targets){const page=await d2Store.source('head',t.path,t.startLine,t.endLine);d2Targets.push({path:t.path,startLine:t.startLine,endLine:t.endLine,contentSha256:page.contentSha256,role:'Frozen historical full-context necessary entity',provenance:'full-context-candidate-dataset-20260925/dataset-final/primary-cases.json'});}
let d2,attempts=[];
try{
 const data=await graphData(historic),units=buildUnits(d2Prefix,data.symbols).units.filter(u=>u.resolution==='resolved');
 for(const pair of legalPlans(units).plans){
  const c={id:'D2',caseId:historic.sourceCaseId,snapshotId:historic.snapshotId,state:historic.state,generationId:historic.generationId,graphSha256:historic.graphSha256,snapshotSha256:historic.snapshotSha256,changedPaths:historic.changedPaths,unit:units.find(u=>u.changeUnitId===pair.changeUnitId),intent:pair.intent};
  const a=await probe(c,d2Prefix),hit=targetInCatalog(a.pack,d2Targets);attempts.push({pair,hit,packHash:hash(a.pack),catalogItems:a.pack.investigations[0].candidateCatalog.length});
  if(hit){const b=await probe(c,d2Prefix);assert.equal(hash(a),hash(b));d2={c,prefix:d2Prefix,execution:a};break;}
 }
}catch(e){attempts.push({error:String(e)});}
admission.push({id:'D2',caseId:historic.sourceCaseId,status:d2?'ADMITTED':'SECOND DEFECT CASE NOT ADMITTED',attempts});
if(d2){selected.splice(1,0,d2);privateTargets.push({id:'D2',caseId:historic.sourceCaseId,snapshotId:historic.snapshotId,label:'defect',targets:d2Targets,sourceMaterial:material});}
const state=join(out,'state'),manifest=[],runner=[];
for(const {c,prefix,execution} of selected){
 const store=await SnapshotStore.load(c.state,c.snapshotId);await access(store.manifest.repositoryPath);
 async function copy(src,dst){await mkdir(dirname(dst),{recursive:true});try{await copyFile(src,dst,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(hash(await readFile(src)),hash(await readFile(dst)));}}
 await copy(join(c.state,'snapshots',c.snapshotId+'.json'),join(state,'snapshots',c.snapshotId+'.json'));
 for(const blob of new Set([...Object.values(store.manifest.base),...Object.values(store.manifest.head)].filter(f=>f.status==='text').map(f=>f.hash)))await copy(join(c.state,'blobs',blob),join(state,'blobs',blob));
 for(const src of [await publishedGraphPath(c.state,c.snapshotId),graphPublishPath(c.state,c.snapshotId)])await copy(src,join(state,relative(c.state,src)));
 const seedId=({D1:'00000000-0000-4000-8000-000000000001',D2:'00000000-0000-4000-8000-000000000002',C1:'00000000-0000-4000-8000-000000000003'})[c.id];
 await save(join(state,'runs',seedId,'run.json'),{schemaVersion:1,runId:seedId,snapshotId:c.snapshotId,referenceOnly:true,purpose:'Frozen snapshot reference for ReviewEngine rerun; never a model run or delivered review.'});
 const target=privateTargets.find(t=>t.id===c.id);for(const t of target.targets){const page=await store.source('head',t.path,t.startLine,t.endLine);assert.equal(page.contentSha256,t.contentSha256);}
 const publicCase={...c,state,repositoryPath:store.manifest.repositoryPath,seedId};
 await save(join(out,'public',c.id+'.json'),{case:publicCase,prefix,prompt:publicPrompt(publicCase,prefix)});
 await save(join(out,'admission',c.id+'.json'),execution);
 manifest.push({id:c.id,caseId:c.caseId,snapshotId:c.snapshotId,changedPaths:c.changedPaths,publicPrefixHash:hash(prefix),ChangeUnit:c.unit,preRegisteredIntent:c.intent,preparedGraphGeneration:c.generationId,privateTargetHash:hash(target)});
 runner.push({id:c.id,path:join(out,'public',c.id+'.json')});
}
await save(join(out,'private/targets.json'),{identity:EXPERIMENT,cases:privateTargets,selectionAccessOnly:true,scoringAfterPredictionFreeze:true});
await save(join(out,'admission.json'),admission);await save(join(out,'case-manifest.json'),manifest);
await save(join(out,'run-config.json'),{identity:EXPERIMENT,model:{provider:'bigmodel',modelId:'glm-5.3-flash'},endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions',temperature:0,top_p:1,thinkingLevel:'low',thinking:{type:'enabled',clear_thinking:false},maxTokens:8192,timeoutMs:600000,requestTimeoutMs:180000,maxToolCalls:100,maxRuns:runner.length*2,firstAttemptOnly:true,providerRetries:0,agentRetries:0,autoCompaction:false,runOrder:runner.flatMap(c=>['A','B'].map(arm=>({id:c.id,arm}))),cases:runner});
await save(join(out,'protocol.json'),{identity:EXPERIMENT,scope:'Pre-registered conditional case-level investigation consumption; not a router or general benchmark.',baselineHead:'70c5a006c6fb749f0db0b526d92a846d1a02b5e0',baselineTests:478,caseSelection:'D1 previous sole actionable miss; D2 historic xarray if current frozen dispatch reaches original necessary range; C1 Requests clean chosen from public diff before model runs.',privateBoundary:'Targets read only for admission and sealed before inference. Public runner receives no target paths/ranges/claims/labels; private scoring requires all attempts frozen.',prefixPolicy:'Same historical public observations in both arms as exploration-only context; current tools must establish diff coverage and source evidence.',arms:{A:['read_diff','search_text','read_source','submit_review'],B:['read_diff','search_text','read_source','expand_structural_candidate','submit_review']},host:'One pre-registered shared dispatch_v2 investigation, <=1 prefetch, frozen budgets and ordering; no router.',scoring:{necessaryFact:'Provider-received immutable source pages cover an entire original frozen necessary range; union of contiguous pages permitted; search snippets and previews excluded.',assistance:'Independent host-dispatch-attribution-2, explicitly selected accepted source only.',graphWin:'B gains necessary fact absent in A and a correct finding or documented correct contract verification absent in A.',bothCorrect:'Both correct; describe cost without labeling a win.',controls:'No new unsupported/false finding in B.',incomplete:'Provider/time/tool failure preserved; never silently replace or treat it as proof of model quality.'},stop:'Mechanical faults stop the case. Semantic failures cause no prompt/catalog/tool tuning or rerun. Stop after this experiment.'});
console.log(JSON.stringify({cases:manifest.map(c=>({id:c.id,caseId:c.caseId,intent:c.preRegisteredIntent})),admission}));
