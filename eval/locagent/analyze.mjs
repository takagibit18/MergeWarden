import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
import {score} from '../../src/eval/metrics.ts';
import {analyzeRetrieval} from '../../src/experiments/locagent/traces.ts';
import {loadCorpus} from '../corpus.mjs';
const output=resolve(process.argv[2]??''),raw=JSON.parse(await readFile(join(output,'raw.json'))),{corpus}=await loadCorpus(undefined,raw.corpusSha256);
const mapping=JSON.parse(await readFile(join(output,'mapping.json')));
if(process.argv.includes('--refresh-traces')){
 const analyses=[];
 for(const r of raw.runs){if(!r.report)continue;const jsonl=await readFile(join(output,'state','runs',r.report.runId,'session.jsonl'),'utf8');const previous=r.trace;
  r.trace=analyzeRetrieval({runKey:r.runKey,snapshotId:r.snapshotId,findings:r.findings,changedPaths:Object.keys(r.report.coverage),jsonl});
  analyses.push({runKey:r.runKey,previousVersion:previous?.version,attributionUnchanged:JSON.stringify(previous?.findings.map(f=>[f.predictionId,f.discoveryPath]))===JSON.stringify(r.trace.findings.map(f=>[f.predictionId,f.discoveryPath])),...r.trace});}
 await writeJson(join(output,'trace-analysis-v3.json'),{rawSha256:sha256(await readFile(join(output,'raw.json'))),reviewImplementationCommit:raw.implementationCommit,analyzerSha256:sha256(await readFile(new URL('../../src/experiments/locagent/traces.ts',import.meta.url))),analyses});
}
const byArm=Object.fromEntries(['T0','G0','G1'].map(arm=>{
 const runs=raw.runs.filter(r=>r.arm===arm),traces=runs.map(r=>r.trace),metrics=traces.map(t=>t?.metrics);
 const numeric=metrics.find(Boolean)??{};
 const sums=Object.fromEntries(Object.keys(numeric).filter(k=>!['firstGraphToolOrdinal','novelNeighborRate'].includes(k)&&(typeof numeric[k]==='number'||numeric[k]===null)).map(k=>[k,metrics.every(m=>m&&typeof m[k]==='number')?metrics.reduce((n,m)=>n+m[k],0):null]));
 const findings=traces.flatMap(t=>t?.findings??[]);
 const maps=mapping.filter(m=>runs.some(r=>r.runKey===m.runKey));
 const scored=maps.every(m=>m.status==='complete')?score(corpus.cases,runs.map(r=>({...r,arm:'text-only'})),maps):null;
 const graphDiagnostics=runs.map(r=>({runKey:r.runKey,...r.manifest?.metrics?.graph}));
 const measured=graphDiagnostics.every(g=>g.calls!==undefined&&g.calls===g.coldRequestMs.length+g.warmRequestMs.length);
 const graphTiming={buildMs:measured?graphDiagnostics.reduce((n,g)=>n+g.buildMs,0):null,coldRequestMs:graphDiagnostics.flatMap(g=>g.coldRequestMs??[]),warmRequestMs:graphDiagnostics.flatMap(g=>g.warmRequestMs??[]),allRequestsMeasured:measured};
 return [arm,{attempted:runs.length,complete:runs.filter(r=>r.delivered&&r.status==='completed').length,metrics:sums,firstGraphToolOrdinals:metrics.map(m=>m?.firstGraphToolOrdinal??null),novelSourceConversionRate:sums.novelEntities?sums.novelEntityToSource/sums.novelEntities:null,searchHitRate:sums.searchCalls?sums.searchHits/sums.searchCalls:null,attribution:Object.fromEntries(['text_only','graph_assisted','ambiguous'].map(p=>[p,findings.filter(f=>f.discoveryPath===p).length])),elapsedMs:runs.reduce((n,r)=>n+r.elapsedMs,0),graphTiming,graphDiagnostics,quality:scored?.byArm['text-only'].quality??null,caseMappings:scored?.perCase??null}];
}));
const verified=raw.sourceUnchanged&&raw.armAudits.length===raw.selected.length&&raw.armAudits.every(a=>a.verified)&&raw.runs.length===raw.selected.length*3&&raw.runs.every(r=>r.trace&&!r.trace.traceIssues.some(issue=>typeof issue==='string'||issue.severity==='fatal'));
const g1=byArm.G1.metrics,g0=byArm.G0.metrics;
const stageDAllowed=raw.stage==='C'&&verified&&(g1.graphAssistedFindings>0||g1.novelEntityToSource>g0.novelEntityToSource&&g1.novelEntityToSource>=1);
const summary={kind:raw.kind,stage:raw.stage,reviewImplementationCommit:raw.implementationCommit,traceAnalysisVersion:raw.runs[0]?.trace?.version,byArm,freezeVerified:verified,stageDAllowed,decision:stageDAllowed?'Predeclared mechanism gate met; eligible for full corpus.':'Do not run full corpus. Audit fidelity and stop if no implementation defect.',interpretation:'Usage totals are null when any attempt has unavailable/interrupted SDK usage. First graph ordinals are a distribution, not an additive measure. Attribution is observed trace provenance, not counterfactual causality. Quality requires explicit semantic mappings. multiHopTraversals counts requests with hops>1; multiHopDiscoveryTraversals separately counts results with newly returned nodes at depth>=2. Invalid-root hint BM25 calls are separate from SearchEntity BM25 calls.'};
await writeJson(join(output,'summary.json'),summary);console.log(JSON.stringify(summary,null,2));
