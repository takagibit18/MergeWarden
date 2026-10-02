// Post-freeze analysis only; never imports or invokes a selector.
import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const out=resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8')),get=n=>read(join(out,n)),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const freeze=await get('prediction-freeze.json');for(const f of freeze.artifacts)assert.equal(hash(await readFile(join(out,f.name))),f.sha256);
const ids=await get('frozen-inputs.json');for(const i of ids)assert.equal(hash(await readFile(i.path)),i.sha256);
const audited=async suffix=>read(ids.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)).path);
const audit=await audited('/private/audit-v2.json'),upstream=await audited('/metrics-b.json');
const arms={A:await get('arm-a-selection.json'),B:await get('arm-b-relevance.json'),C:await get('arm-c-hybrid.json')},relevance=await get('candidate-relevance.json'),reasons=await get('selection-reasons.json');
const rows=audit.cases.filter(c=>arms.C.some(r=>r.id===c.id)).map(c=>{
 const targets=c.targetEntities.map(targetId=>{
  const u=upstream.find(r=>r.id===c.id).targets.find(t=>t.targetId===targetId),rank=relevance.find(r=>r.id===c.id).rows.find(r=>r.candidateId===targetId);assert.ok(u&&rank);
  const choices=Object.fromEntries(Object.entries(arms).map(([arm,rs])=>{const s=rs.find(r=>r.id===c.id).selection.selected,index=s.findIndex(s=>s.candidate.terminalEntityId===targetId);return [arm,{candidateSelected:index>=0,slot:index>=0?index+1:null,selectionReason:index>=0?s[index].selectedBecause:null}];}));
  return {targetId,targetName:u.targetName,targetRelationExistsInGraph:u.targetRelationExistsInGraph,edgeInspected:u.edgeInspected,entityReached:u.entityReached,pathRetained:u.pathRetained,requiredPathRetained:u.requiredPathRetained,...choices,lexicalRank:rank.rank,rawBm25:rank.rawBm25,matchedTokens:rank.matchedTokens,candidateSelected:choices.C.candidateSelected,sourceRead:false,necessaryFactCovered:null,downstreamExecution:'NOT_RUN: candidate gate prerequisite',failureStage:choices.C.candidateSelected?'F4_CANDIDATE_SELECTED_SOURCE_NOT_READ':'F3_PATH_RETAINED_CANDIDATE_DROPPED'};
 });
 return {id:c.id,targets,...Object.fromEntries(Object.keys(arms).map(arm=>[arm,targets.every(t=>t[arm].candidateSelected)]))};
});assert.equal(rows.length,6);
const controls=['D1-direct-caller','D3-xarray-multihop','D5-reexport'],fresh=['S1-same-file-intermediate','H-scikit-learn','H-sympy'],complex=['D3-xarray-multihop',...fresh],count=(names,arm)=>rows.filter(r=>names.includes(r.id)&&r[arm]).length;
const armMetrics=Object.fromEntries(Object.keys(arms).map(arm=>[arm,{controlsSelected:count(controls,arm),newSelected:count(fresh,arm),complexSelected:count(complex,arm)}]));
assert.deepEqual(armMetrics.A,{controlsSelected:3,newSelected:1,complexSelected:2});
const m=armMetrics.C,pass=m.controlsSelected===3&&m.newSelected>=2&&m.complexSelected>=3;
const gate={candidate:pass?'PASS':'FAIL',promotionArm:'C',armMetrics,requirements:{controls:3,newTargets:2,complex:3},sourceReplayAllowed:pass};
await save('scorer-results.json',{scoredAt:new Date().toISOString(),predictionFreezeSha256:hash(await readFile(join(out,'prediction-freeze.json'))),rows,gate});await save('gate.json',gate);await save('funnel.json',rows.map(({id,targets})=>({id,targets})));
const diagnoses=rows.map(r=>({id:r.id,targets:r.targets.map(t=>({targetId:t.targetId,targetName:t.targetName,lexicalRank:t.lexicalRank,rawBm25:t.rawBm25,B:t.B,C:t.C,rounds:reasons.find(x=>x.id===r.id).rounds.map(round=>({slot:round.slot,targetScore:round.candidates.find(c=>c.candidateId===t.targetId)??null,winner:round.candidates[0]}))})),selectedC:reasons.find(x=>x.id===r.id).C,top10:relevance.find(x=>x.id===r.id).rows.slice(0,10)}));await save('post-freeze-diagnosis.json',diagnoses);
if(!pass){await save('source-replay-status.json',{status:'NOT_RUN',reason:'Arm C Candidate Gate FAIL',sourceReads:0,graphBackendRequests:0,realModelCalls:0,complexNecessaryFactCovered:null});await save('final-status.json',{outcome:'NOT READY — HYBRID CANDIDATE SELECTION FAILED',gate2Overall:'NOT CLOSED',readyForV3:false,readyForLive:false,V3:'NOT STARTED',Live:'NOT STARTED',realModelCalls:0});}
console.log(JSON.stringify(gate));
