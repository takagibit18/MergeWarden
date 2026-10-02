import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeTrace} from '../src/eval/traces.ts';
import {readReport} from '../src/engine/reports.ts';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {checkEvidence} from '../src/application/evidence-check.ts';
import {sha256,writeJson} from '../src/infrastructure/files.ts';
import {score} from '../src/eval/metrics.ts';
import {validateHumanReview} from '../src/eval/human-review.ts';
import {loadCorpus} from './corpus.mjs';
const ratio=(n,d)=>d?n/d:null;

export function summarizeTraces(runs,mappings){
 const good=runs.filter(r=>r.analysisStatus==='ok');
 const byArm=Object.fromEntries(['text-only','text+graph'].map(arm=>{
  const all=runs.filter(r=>r.arm===arm),rows=good.filter(r=>r.arm===arm);
  const sum=key=>rows.reduce((n,r)=>n+r.metrics[key],0);
  const sumConversion=(key,field)=>rows.reduce((n,r)=>n+r.metrics[key][field],0);
  const first=rows.map(r=>r.metrics.firstGraphToolOrdinal).filter(n=>n!==null).sort((a,b)=>a-b);
  const convertedLookup=sumConversion('lookupToNeighbors','converted'),eligibleLookup=sumConversion('lookupToNeighbors','eligible');
  const convertedNeighbors=sumConversion('neighborsToReadSource','converted'),eligibleNeighbors=sumConversion('neighborsToReadSource','eligible');
  const findings=rows.flatMap(r=>r.findings);const discoveryPaths=Object.fromEntries(['text_only','graph_assisted','ambiguous'].map(p=>[p,findings.filter(f=>f.discoveryPath===p).length]));
  return [arm,{attemptedRuns:all.length,analyzedRuns:rows.length,unavailableRuns:all.length-rows.length,
   graphUsedRuns:rows.filter(r=>r.metrics.graphToolCalls>0).length,toolCalls:sum('toolCalls'),graphToolCalls:sum('graphToolCalls'),graphResults:sum('graphResults'),
   firstGraphToolOrdinals:first,firstGraphToolOrdinalMean:first.length?first.reduce((a,b)=>a+b,0)/first.length:null,
   lookupCalls:sum('lookupCalls'),lookupSuccessfulCalls:sum('lookupSuccessfulCalls'),lookupHits:sum('lookupHits'),lookupSuccessRate:ratio(sum('lookupSuccessfulCalls'),sum('lookupCalls')),lookupHitRate:ratio(sum('lookupHits'),sum('lookupCalls')),
   lookupToNeighbors:{converted:convertedLookup,eligible:eligibleLookup,rate:ratio(convertedLookup,eligibleLookup)},neighborsToReadSource:{converted:convertedNeighbors,eligible:eligibleNeighbors,rate:ratio(convertedNeighbors,eligibleNeighbors)},
   newCallerReadConversions:sum('newCallerReadConversions'),searchTextCalls:sum('searchTextCalls'),readSourceCalls:sum('readSourceCalls'),rejectedSubmissions:sum('rejectedSubmissions'),
   runsWithIncompleteUsage:rows.filter(r=>r.usage.incompleteUsage).length,interruptedResponses:rows.reduce((n,r)=>n+r.usage.interruptedResponses,0),
   graphResponseUtf8Bytes:sum('graphResponseUtf8Bytes'),graphResponseCharacters:sum('graphResponseCharacters'),graphResponseTokens:null,graphResponseTokenEstimate:sum('graphResponseTokenEstimate'),discoveryPaths}];
 }));
 const comparisons=[];const graphAssistedWithoutTextMatch=[];
 for(const g of good.filter(r=>r.arm==='text+graph')){
  const t=good.find(r=>r.caseId===g.caseId&&r.repeat===g.repeat&&r.arm==='text-only');if(!t)continue;
  comparisons.push({caseId:g.caseId,repeat:g.repeat,textStatus:t.status,graphStatus:g.status,textRunKey:t.runKey,graphRunKey:g.runKey,
   searchText:{text:t.metrics.searchTextCalls,graph:g.metrics.searchTextCalls,delta:g.metrics.searchTextCalls-t.metrics.searchTextCalls},
   readSource:{text:t.metrics.readSourceCalls,graph:g.metrics.readSourceCalls,delta:g.metrics.readSourceCalls-t.metrics.readSourceCalls}});
  if(!mappings)continue;
  const gm=mappings.find(m=>m.runKey===g.runKey),tm=mappings.find(m=>m.runKey===t.runKey);
  if(gm?.status!=='complete'||tm?.status!=='complete')continue;
  const textGold=new Set(tm.predictions.filter(p=>p.goldenId!==null).map(p=>p.goldenId));
  for(const f of g.findings.filter(f=>f.discoveryPath==='graph_assisted')){
   const match=gm.predictions.find(p=>p.predictionId===f.predictionId);
   if(match?.goldenId&&!textGold.has(match.goldenId))graphAssistedWithoutTextMatch.push({caseId:g.caseId,repeat:g.repeat,graphRunKey:g.runKey,textRunKey:t.runKey,predictionId:f.predictionId,goldenId:match.goldenId,textCompleted:t.status==='completed'&&t.delivered,chains:f.chains.filter(c=>c.novelToText)});
  }
 }
 return {byArm,comparisons,graphAssistedWithoutTextMatch:mappings?graphAssistedWithoutTextMatch:null,
  interpretation:'Trace attribution is an observable discovery path, not proof of counterfactual causality. Cross-arm differences require semantic golden mappings and include partial attempts. Returned Graph token counts are unavailable; the separate character/4 estimate is not GLM tokenization or billed context replay. SDK usage on interrupted/missing-usage responses may omit provider consumption; reported totals are not a complete billing record.'};
}

async function main(){
 const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};if(!get('--output'))throw Error('Use --output EVALUATION_DIRECTORY [--mapping FILE] [--partial]');
 const output=resolve(get('--output')),rawBytes=await readFile(join(output,'raw.json'),'utf8'),raw=JSON.parse(rawBytes),state=resolve(get('--state')??join(output,'state'));
 const selectedCorpus=(get('--human-review')||get('--mapping'))?await loadCorpus(get('--corpus'),raw.corpusSha256):undefined;
 const partial=args.includes('--partial');if(!partial&&(raw.sourceUnchanged!==true||!raw.pairAudits?.every(a=>a.verified)))throw Error('Experiment source/configuration freeze is not verified; use --partial for a clearly provisional analysis');
 const runs=[];
 for(const run of raw.runs){
  const identity={runKey:run.runKey,caseId:run.caseId,repeat:run.repeat,arm:run.arm,status:run.status,delivered:run.delivered};
  if(!run.delivered||!run.report){runs.push({...identity,analysisStatus:'unavailable',reason:'No delivered report/native run to attribute'});continue;}
  const report=await readReport(state,run.report.runId);if(report.snapshot.id!==run.snapshotId||JSON.stringify(report.findings)!==JSON.stringify(run.findings))throw Error('Saved report differs from evaluation raw');
  const store=await SnapshotStore.load(state,run.snapshotId);for(const finding of report.findings)if(!(await checkEvidence(finding,store)).ok)throw Error('Immutable finding evidence failed integrity verification');
  const traceFile=join(state,'runs',report.runId,'session.jsonl'),jsonl=await readFile(traceFile,'utf8');
  const analysis=analyzeTrace({runKey:run.runKey,snapshotId:run.snapshotId,findings:report.findings,jsonl,changedPaths:Object.keys(report.coverage)});
  runs.push({...identity,...analysis,analysisStatus:analysis.traceIssues.length?'trace_incomplete':'ok',traceFile,reportIntegrityVerified:true,evidenceIntegrityVerified:true});
 }
 let mappings;let humanReview={status:'pending_independent_human_review',reviewed:0,total:20,allAccepted:false};
 if(get('--human-review')){const declaration=JSON.parse(await readFile(resolve(get('--human-review')),'utf8'));const receipt=validateHumanReview(declaration,selectedCorpus.corpus.cases,raw.corpusSha256);humanReview={status:receipt.complete?'human_review_complete':'human_review_partial',...receipt};}
 if(get('--mapping')){mappings=JSON.parse(await readFile(resolve(get('--mapping')),'utf8'));score(selectedCorpus.corpus.cases,raw.runs,mappings);}
 const analyzerSha256=sha256((await readFile(new URL('../src/eval/traces.ts',import.meta.url),'utf8'))+(await readFile(new URL('./traces.mjs',import.meta.url),'utf8')));
 const result={schemaVersion:1,attributionVersion:'trace-attribution-2',provisional:partial||raw.sourceUnchanged!==true,rawSha256:sha256(rawBytes),corpusSha256:raw.corpusSha256,implementationFingerprint:raw.implementationFingerprint,analyzerSha256,
  definitions:{toolOrdinal:'One-based issued tool call order on the last native branch, including rejected and unanswered calls.',lookupSuccess:'Non-error, snapshot-matched ok/parse_incomplete response; hit additionally requires returned symbol IDs. Empty success is not a hit.',lookupToNeighbors:'Fraction of hit lookups linked to a later-issued neighbors call using a returned symbol ID; most recent matching lookup receives the conversion.',neighborsToReadSource:'Fraction of successful nonempty neighbors calls followed by a separately issued HEAD source read covering a returned provenance range; this is navigation, not necessarily new discovery.',novelty:'Strict path-level text novelty in both revisions: any earlier source/diff/search exposure before the source call prevents strict graph-assisted credit.',graphAssisted:'Resolved incoming CALLS -> caller path not previously exposed by text -> separately issued source read covering the call site -> accepted final finding evidence includes that site.',textOnly:'Accepted source evidence predates Graph, or no observed relevant Graph result led to those evidence locations.',ambiguous:'Missing/corrupt trace or missing accepted evidence chain; or relevant Graph exposure with competing text discovery, uncertain edges, same-batch pre-issued reads, or unsupported navigation.',tokens:'Exact per-tool GLM tokens unavailable. graphResponseTokenEstimate is Unicode code points / 4 rounded up per run; response text counted once; excludes context replay.'},
  humanReview,runs,...summarizeTraces(runs,mappings)};
 await writeJson(join(output,partial?'trace-analysis.partial.json':'trace-analysis.json'),result);
 console.log(JSON.stringify({provisional:result.provisional,byArm:result.byArm,graphAssistedWithoutTextMatch:result.graphAssistedWithoutTextMatch},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
