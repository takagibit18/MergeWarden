import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {analyzeRetrieval} from '../src/experiments/locagent/traces.ts';
import {observe} from '../src/eval/provenance/observations.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
/** Historical predictions and references are read-only. No correctness labels enter attribution. */
export async function replay(datasets){
 const originals=[],results=[],inputs=[];
 const read=async path=>{const bytes=await readFile(path);inputs.push({path:resolve(path),sha256:hash(bytes)});return bytes.toString('utf8').replace(/^\uFEFF/,'');};
 for(const directory of datasets){
  const saved=JSON.parse(await read(join(directory,'live-results.json')));
  await read(join(directory,'protocol.json'));
  for(const run of saved.runs){
   if(!run.runId)throw Error('Historical run lacks native session identity');
   const root=join(directory,'state','runs',run.runId);
   const native=await read(join(root,'session.jsonl'));
   const report=JSON.parse(await read(join(root,'report.json')));
   await read(join(root,'report.md'));await read(join(root,'run.json'));
   if(json(report.findings)!==json(run.findings))throw Error('Saved predictions disagree with delivered report');
   if(hash(native)!==run.trace.traceSha256)throw Error('Native trace differs from frozen v2 input');
   const identity={dataset:resolve(directory).split(/[\\/]/).at(-1),caseId:run.caseId,arm:run.arm??run.group,runId:run.runId};
   originals.push({...identity,attribution:run.trace});
   const input={runKey:run.trace.runKey,snapshotId:report.snapshot.id,findings:report.findings,jsonl:native,changedPaths:Object.keys(report.coverage)};
   const analysis=analyzeRetrieval(input),observed=observe(input);
   if(json(analysis)!==json(analyzeRetrieval(input)))throw Error('Nondeterministic replay');
   const verifiedNovelPaths=[...new Set(observed.sourceLinks.filter(l=>l.strictNovel).map(l=>l.location.path))];
   const evidencePaths=[...new Set(report.findings.flatMap(f=>f.evidence.map(e=>e.path)))];
   results.push({...identity,verifiedNovelPaths,novelPathsOmittedFromAllAcceptedEvidence:verifiedNovelPaths.filter(p=>!evidencePaths.includes(p)),analysis});
  }
 }
 for(const input of inputs)if(hash(await readFile(input.path))!==input.sha256)throw Error('Historical input mutated during replay');
 return {originals,results,inputs};
}
export function diffReport(data){
 const lines=['# Attribution v3 historical replay','','Reclassification is a measurement correction, not model improvement. Predictions and final EvidenceRefs are unchanged. No reference labels enter this analyzer.','','| Dataset / case / arm | Finding | v2 | v3 | Assistance | Reason |','|---|---|---|---|---|---|'];
 for(const run of data.results){
  const old=data.originals.find(r=>r.runId===run.runId).attribution;
  for(const f of run.analysis.findings){
   const before=old.findings.find(o=>o.predictionId===f.predictionId);
   lines.push(`| ${run.dataset} / ${run.caseId} / ${run.arm} | ${f.predictionId} | ${before?.discoveryPath??'missing'} | ${f.discoveryPath} | ${f.assistanceKind.join(', ')||'none'} | ${f.discoveryPath==='graph_assisted'&&before?.discoveryPath!=='graph_assisted'?f.entitySearchAssisted?'Measurement reclassification: entity-search assistance now has its own category; local errors do not poison accepted evidence':before?.chains?.length?'Measurement reclassification: earlier local errors no longer poison the complete accepted chain':'Measurement reclassification: match every later exact source read, not only the first range; novelty is measured before first Graph exposure':f.discoveryPath==='text_only'&&run.novelPathsOmittedFromAllAcceptedEvidence.length?'Final evidence omission: read source is not selected evidence; no credit added':f.reason} |`);
  }
  if(!run.analysis.findings.length)lines.push(`| ${run.dataset} / ${run.caseId} / ${run.arm} | none | none | none | none | No accepted finding |`);
 }
 lines.push('','## Novel source read but omitted from accepted evidence','');
 for(const r of data.results.filter(r=>r.novelPathsOmittedFromAllAcceptedEvidence.length))lines.push(`- ${r.dataset} / ${r.caseId} / ${r.arm}: ${r.novelPathsOmittedFromAllAcceptedEvidence.join(', ')}. Reading a source is not evidence selection; no counterfactual evidence is attached.`);
 return lines.join('\n')+'\n';
}
async function immutable(path,content){try{await writeFile(path,content,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==content)throw Error('Refusing to overwrite differing replay artifact: '+path);}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [out,...datasets]=process.argv.slice(2);if(!out||!datasets.length)throw Error('Usage: replay-attribution-v3.mjs OUTPUT DATASET...');
 const first=await replay(datasets),second=await replay(datasets);
 if(json(first)!==json(second))throw Error('Replay differs between passes');
 await mkdir(out,{recursive:true});
 await immutable(join(out,'attribution-v2-original.json'),json(first.originals));
 await immutable(join(out,'attribution-v3-replay.json'),json(first.results));
 await immutable(join(out,'replay-inputs.json'),json(first.inputs));
 await immutable(join(out,'attribution-diff.md'),diffReport(first));
 await immutable(join(out,'replay-determinism.json'),json({version:'trace-attribution-3',runs:first.results.length,passes:2,byteStable:true,sha256:hash(json(first.results)),originalInputsUnchanged:true}));
 console.log(JSON.stringify({runs:first.results.length,byteStable:true,oldGraphAssisted:first.originals.reduce((n,r)=>n+r.attribution.findings.filter(f=>f.discoveryPath==='graph_assisted').length,0),newGraphAssisted:first.results.reduce((n,r)=>n+r.analysis.findings.filter(f=>f.discoveryPath==='graph_assisted').length,0)}));
}
