// Independent post-freeze scorer. It never imports or runs either selector.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=resolve(process.argv[2]),read=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const freeze=await read(join(out,'prediction-freeze.json'));
for(const f of freeze.artifacts)assert.equal(hash(await readFile(join(out,f.name))),f.sha256);
const identities=await read(join(out,'frozen-inputs.json'));
for(const f of identities)assert.equal(hash(await readFile(f.path)),f.sha256);
const audited=async suffix=>read(identities.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)).path);
const audit=await audited('/private/audit-v2.json'),upstream=await audited('/metrics-b.json');
const arms={A:await read(join(out,'arm-a-selection.json')),B:await read(join(out,'arm-b-selection.json'))};
const rows=audit.cases.filter(c=>arms.B.some(r=>r.id===c.id)).map(c=>{
 const old=upstream.find(r=>r.id===c.id);
 const targets=c.targetEntities.map(targetId=>{
  const t=old.targets.find(t=>t.targetId===targetId);assert.ok(t);
  const choices=Object.fromEntries(Object.entries(arms).map(([arm,rs])=>{
   const selected=rs.find(r=>r.id===c.id).selection.selected,idx=selected.findIndex(s=>s.candidate.terminalEntityId===targetId);
   return [arm,{candidateSelected:idx>=0,slot:idx>=0?idx+1:null,selectionReason:idx>=0?selected[idx].selectedBecause:null}];
  }));
  return {targetId,targetName:t.targetName,targetRelationExistsInGraph:t.targetRelationExistsInGraph,edgeInspected:t.edgeInspected,entityReached:t.entityReached,pathRetained:t.pathRetained,requiredPathRetained:t.requiredPathRetained,...choices,candidateSelected:choices.B.candidateSelected,sourceRead:false,necessaryFactCovered:null,downstreamExecution:'NOT_RUN: candidate gate prerequisite',failureStage:choices.B.candidateSelected?'F4_CANDIDATE_SELECTED_SOURCE_NOT_READ':'F3_PATH_RETAINED_CANDIDATE_DROPPED',stageInterpretation:choices.B.candidateSelected?'Intentional stop before source execution; not a measured source-pipeline failure':'Observed selection miss in frozen retained pool'};
 });
 return {id:c.id,targets,requiredEdges:old.requiredEdges,A:targets.every(t=>t.A.candidateSelected),B:targets.every(t=>t.B.candidateSelected)};
});
const controls=['D1-direct-caller','D3-xarray-multihop','D5-reexport'],fresh=['S1-same-file-intermediate','H-scikit-learn','H-sympy'],complex=['D3-xarray-multihop',...fresh];
const count=(names,arm)=>rows.filter(r=>names.includes(r.id)&&r[arm]).length;
assert.equal(rows.length,6);assert.equal(count(controls,'A'),3);assert.equal(count(fresh,'A'),0);
const pass=count(controls,'B')===3&&count(fresh,'B')>=2&&count(complex,'B')>=3;
const gate={candidate:pass?'PASS':'FAIL',controlsSelected:count(controls,'B'),controlsTotal:3,newSelected:count(fresh,'B'),newTotal:3,complexSelected:count(complex,'B'),complexTotal:4,baselineComplexSelected:count(complex,'A'),sourceReplayAllowed:pass};
await save('scorer-results.json',{scoredAt:new Date().toISOString(),predictionFreezeSha256:hash(await readFile(join(out,'prediction-freeze.json'))),upstreamEvidence:'Hash-validated Gate 2B metrics; unchanged exploration and retention',rows,gate});
await save('gate.json',gate);await save('funnel.json',rows.map(({id,targets})=>({id,targets})));
if(!pass){await save('source-replay.json',{status:'NOT_RUN',reason:'Candidate Path-Coverage Gate FAIL; protocol stop rule',sourceReads:0,graphBackendRequests:0,realModelCalls:0,complexNecessaryFactCovered:null});await save('final-status.json',{outcome:'NOT READY — CANDIDATE SELECTION FAILED',gate2Overall:'NOT CLOSED',readyForV3:false,readyForLive:false,V3:'NOT STARTED',Live:'NOT STARTED',realModelCalls:0});}
console.log(JSON.stringify(gate));
