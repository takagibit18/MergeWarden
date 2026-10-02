import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {digest} from './real/open-label.mjs';
const out=resolve(process.argv[2]),read=async p=>JSON.parse(await readFile(join(out,p),'utf8'));
const experiment=await read('experiment.json'),selection=await read('e2e-case-manifest.json'),latest=await read('latest.json');
let audit;try{audit=await read('semantic-audit.json');}catch(e){if(e.code!=='ENOENT')throw e;}
const rows=[];
for(const run of latest.runs){
 const m=run.manifest?.metrics,o=run.observation,known=o?.usageComplete===true;
 const label=selection.cases.find(c=>c.caseId===run.caseId),score=audit?.runs.find(s=>s.caseId===run.caseId&&s.arm===run.arm);
 let sourceReads=null; if(run.runId){const entries=(await readFile(join(out,'state/runs',run.runId,'session.jsonl'),'utf8')).trim().split(/\r?\n/).map(JSON.parse);
 sourceReads=entries.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&['read_source','expand_structural_candidate'].includes(e.message.toolName)&&!e.message.isError).length;}
 rows.push({caseId:run.caseId,arm:run.arm,stratum:label.stratum,phase:label.phase,status:run.status,completed:run.status==='completed'&&run.delivered,
  input:known?run.manifest.usage.input:null,output:known?run.manifest.usage.output:null,total:known?run.manifest.usage.total:null,knownPartialUsage:!known?run.manifest?.usage??null:null,
  latencyMs:m?.reviewLatencyMs??run.elapsedMs??null,toolCalls:m?.toolExecuted??null,sourceReads,graphOperations:m?.dispatch?.operations?m.dispatch.operations.executed-(m.dispatch.sourceReadOperations??0):0,
  routeActivation:m?.routing?.activated??0,rootsResolved:m?.dispatch?.rootsResolved??0,candidatePackages:o?.candidatePackagesDelivered??0,hostPrefetch:o?.hostPrefetchDelivered??0,modelExpansion:m?.dispatch?.candidateExpansionReads??0,
  graphAssistedAccepted:run.trace?.findings?.filter(f=>f.hostPrefetchedRefs.length||f.modelExpandedRefs.length).length??0,
  defectHit:score?.defectHit??null,unsupportedFinding:score?.unsupportedFinding??null,relevantSourceReached:score?.relevantSourceReached??null,operationsToRelevantSource:score?.operationsToRelevantSource??null,runId:run.runId??null});
}
const values=(xs,key)=>xs.map(r=>r[key]).filter(x=>typeof x==='number').sort((a,b)=>a-b);
const median=xs=>!xs.length?null:xs.length%2?xs[(xs.length-1)/2]:(xs[xs.length/2-1]+xs[xs.length/2])/2;
const metric=(xs,key)=>{const v=values(xs,key);return {known:v.length,missing:xs.length-v.length,total:v.length?v.reduce((a,b)=>a+b,0):null,median:median(v),p75:v[Math.max(0,Math.ceil(v.length*.75)-1)]??null,max:v.at(-1)??null};};
const pairedIds=selection.cases.filter(c=>rows.filter(r=>r.caseId===c.caseId&&r.completed).length===2).map(c=>c.caseId);
const arm=(name)=>{const xs=rows.filter(r=>r.arm===name),defects=xs.filter(r=>r.stratum!=='clean'),cross=xs.filter(r=>r.stratum==='cross_file'),clean=xs.filter(r=>r.stratum==='clean');return {
 runs:xs.length,completed:xs.filter(r=>r.completed).length,defectHit:audit?{hit:defects.filter(r=>r.defectHit).length,total:defects.length}:null,crossFileHit:audit?{hit:cross.filter(r=>r.defectHit).length,total:cross.length}:null,cleanFP:audit?{cases:clean.filter(r=>r.unsupportedFinding).length,total:clean.length}:null,
 input:metric(xs,'input'),output:metric(xs,'output'),tokens:metric(xs,'total'),latency:metric(xs,'latencyMs'),toolCalls:metric(xs,'toolCalls'),sourceReads:metric(xs,'sourceReads'),graphOperations:metric(xs,'graphOperations'),completedPaired:{pairs:pairedIds.length,input:metric(xs.filter(r=>pairedIds.includes(r.caseId)),'input'),output:metric(xs.filter(r=>pairedIds.includes(r.caseId)),'output'),tokens:metric(xs.filter(r=>pairedIds.includes(r.caseId)),'total')},activatedCases:xs.filter(r=>r.candidatePackages||r.hostPrefetch||r.modelExpansion).length,
 relevantSourceReached:audit?xs.filter(r=>r.relevantSourceReached).length:null,graphAssistedAccepted:xs.reduce((n,r)=>n+r.graphAssistedAccepted,0)};};
const summary={A:arm('A'),B:arm('B')};
const pilot=rows.filter(r=>r.phase==='pilot');
let state='RUNNING';
if(pilot.length===16){state=pilot.filter(r=>r.completed).length<12||['A','B'].some(a=>pilot.filter(r=>r.arm===a&&r.completed).length<6)?'NOT_READY_EXECUTION'
 :pilot.filter(r=>r.arm==='B'&&(r.candidatePackages||r.hostPrefetch||r.modelExpansion)).length<3?'NOT_READY_ACTIVATION':'PILOT_PASS';}
if(latest.runs.length<16)state='NOT_READY_CORRECTNESS';
const result={identity:experiment.identity,experimentSha256:experiment.experimentSha256,predictionSha256:digest(latest.runs),state,qualityAudited:!!audit,summary,rows};
await writeFile(join(out,'paired-e2e-results.json'),JSON.stringify(result,null,2)+'\n');
const keys=['caseId','arm','stratum','status','completed','defectHit','unsupportedFinding','input','output','total','latencyMs','toolCalls','sourceReads','graphOperations','candidatePackages','hostPrefetch','modelExpansion','graphAssistedAccepted','relevantSourceReached','operationsToRelevantSource'];
await writeFile(join(out,'paired-e2e-summary.csv'),keys.join(',')+'\n'+rows.map(r=>keys.map(k=>r[k]??'').join(',')).join('\n')+'\n');
if(state==='PILOT_PASS'&&latest.runs.length===16)await writeFile(join(out,'checkpoint-review.json'),JSON.stringify({decision:'CONTINUE',experimentSha256:experiment.experimentSha256,reviewedRuns:16,observedRunsSha256:digest(latest.runs),basis:'User-authorized pilot thresholds; quality labels still unopened',summary},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({state,runs:rows.length,summary},null,2));
