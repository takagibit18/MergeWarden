import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RealCorpusAdapter} from './real/cache.mjs';
import {SqliteCodeGraph,publishedGraphPath,readGraphEntities,readGraphRelations} from '../src/graph/sqlite-store.ts';
import {LazyCodeGraph} from '../src/graph/lazy-graph.ts';
import {LazyLocAgent} from '../src/experiments/locagent/lazy.ts';
import {prepareGraphCases} from './real/graph-preparation.mjs';

// Frozen before measurement. Do not relax these values after observing results.
export const HOT_GRAPH_THRESHOLDS={g0P95Ms:500,g0MaxMs:2000,g1P95Ms:500,g1MaxMs:2000,measuredRequests:100,warmups:5,maxWorkerStarts:1,maxMonotonicMemorySamples:50};
const selected=['RG2-9a9c0b930264','RG2-36fc7cf7f8d0','RG-C035','RG-C008','RG2-8a20ce3c59fd','RG2-1f682ac2d7bb','RG2-7b899db872f4','RG2-ae0ac5357175'];
const get=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error('Missing '+name);return process.argv[i+1];};
const jsonl=async path=>(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const quantiles=values=>{const s=[...values].sort((a,b)=>a-b),q=p=>s[Math.max(0,Math.ceil(s.length*p)-1)]??null;return {count:s.length,p50:q(.5),p75:q(.75),p90:q(.9),p95:q(.95),max:s.at(-1)??null};};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const longestIncrease=values=>{let best=0,run=0;for(let i=1;i<values.length;i++){run=values[i]>values[i-1]?run+1:0;best=Math.max(best,run);}return best;};

async function tasks(){
 const publicTasks=await jsonl(new URL('./real/corpora/mergewarden-real-python40-v1/public/tasks.jsonl',import.meta.url)),byId=new Map(publicTasks.map(task=>[task.case_id,task]));
 const closure=JSON.parse(await readFile(new URL('./real/manifests/closure-index.json',import.meta.url),'utf8'));
 for(const row of closure.records)if(selected.includes(row.candidateId))byId.set(row.candidateId,{case_id:row.candidateId,repository:row.repository,repository_url:`https://github.com/${row.repository}.git`,base_sha:row.profile.baseSha,reviewed_sha:row.profile.reviewedSha,language:'Python',review_context_policy:'repository'});
 return selected.map(id=>{const task=byId.get(id);if(!task)throw Error('Pinned benchmark task missing: '+id);return task;});
}
function graphData(path,snapshotId){const db=new DatabaseSync(path,{readOnly:true});try{return {entities:readGraphEntities(db,snapshotId),relations:readGraphRelations(db,snapshotId)};}finally{db.close();}}
function queryPlan(store,entities,relations){
 const byId=new Map(entities.map(e=>[e.id,e])),stable=[...entities].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const changedFile=stable.find(e=>e.kind==='file'&&store.manifest.changedPaths.includes(e.path)),exact=changedFile??stable.find(e=>e.kind==='class'||e.kind==='function')??stable[0];
 const calls=[...relations.filter(r=>r.relation==='CALLS')].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const structural=[...relations.filter(r=>r.relation==='IMPORTS'||r.relation==='CONTAINS')].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const degrees=new Map();for(const r of relations){for(const id of [r.fromId,r.toId])degrees.set(id,(degrees.get(id)??0)+1);}
 const high=[...degrees].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'en'))[0];
 const highEdges=relations.filter(r=>r.fromId===high?.[0]||r.toId===high?.[0]).sort((a,b)=>a.id.localeCompare(b.id,'en')),highEdge=highEdges[0]??structural[0]??calls[0];
 if(!exact||!highEdge)throw Error('Graph lacks deterministic benchmark entities/relations');
 const incoming=calls[0]??highEdge,outgoing=calls[0]??highEdge,structure=structural[0]??highEdge;
 return {exact,queries:[
  {kind:'lookup',input:{snapshotId:store.manifest.identity.id,query:exact.kind==='file'?exact.path:exact.qualifiedName,limit:20}},
  {kind:'neighbors',input:{snapshotId:store.manifest.identity.id,symbolId:incoming.toId,relation:incoming.relation,direction:'incoming',limit:100}},
  {kind:'neighbors',input:{snapshotId:store.manifest.identity.id,symbolId:outgoing.fromId,relation:outgoing.relation,direction:'outgoing',limit:100}},
  {kind:'neighbors',input:{snapshotId:store.manifest.identity.id,symbolId:structure.fromId,relation:structure.relation,direction:'outgoing',limit:100}},
  {kind:'neighbors',input:{snapshotId:store.manifest.identity.id,symbolId:highEdge.fromId===high?.[0]?highEdge.fromId:highEdge.toId,relation:highEdge.relation,direction:highEdge.fromId===high?.[0]?'outgoing':'incoming',limit:100}},
 ],g1:[
  {kind:'search_entity',input:{searchTerms:[exact.name],topK:10}},
  {kind:'search_entity',input:{searchTerms:[exact.qualifiedName.replaceAll('.',' ')],topK:10}},
  {kind:'traverse_graph',input:{startEntities:[exact.id],direction:'both',maxHops:1,entityTypeFilter:[],relationTypeFilter:[],maxNodes:100,maxBytes:32768}},
  {kind:'traverse_graph',input:{startEntities:[exact.id],direction:'both',maxHops:3,entityTypeFilter:[],relationTypeFilter:[],maxNodes:100,maxBytes:32768}},
 ]};
}
async function benchmarkG0(store,plan){
 const service=new LazyCodeGraph(store.stateDir,store.manifest.identity.id,{preparedOnly:true});
 const run=async q=>q.kind==='lookup'?service.lookup(q.input):service.neighbors(q.input);
 for(let i=0;i<HOT_GRAPH_THRESHOLDS.warmups;i++)await run(plan.queries[i%plan.queries.length]);
 const round=[],query=[],responseBytes=[],items=[],errors=[];const rss=[];
 for(let i=0;i<HOT_GRAPH_THRESHOLDS.measuredRequests;i++){const q=plan.queries[i%plan.queries.length],before=service.metrics.queryMs,start=performance.now();const page=await run(q);round.push(performance.now()-start);query.push(service.metrics.queryMs-before);responseBytes.push(bytes(page));items.push(page.items?.length??0);rss.push(process.memoryUsage().rss);if(page.status==='error')errors.push({i,warnings:page.warnings});}
 const generationId=service.metrics.generationId,workerStarts=service.metrics.workerStarts,protocol={buildMs:service.metrics.buildMs,extractedFiles:service.metrics.extractedFiles,resolvedFiles:service.metrics.resolvedFiles,resumedFiles:service.metrics.resumedFiles,resumedResolutionFiles:service.metrics.resumedResolutionFiles,coldRequests:service.metrics.coldRequestMs.length};await service.dispose();
 return {roundTripMs:quantiles(round),queryMs:quantiles(query),responseBytes:quantiles(responseBytes),returnedItems:quantiles(items),errors,workerStarts,generationId,memory:{rssStart:rss[0],rssEnd:rss.at(-1),rssMax:Math.max(...rss),longestMonotonicIncrease:longestIncrease(rss)},protocol};
}
async function benchmarkG1(store,plan){
 const service=new LazyLocAgent(store.stateDir,store.manifest.identity.id,{}, {preparedOnly:true});
 const first=await service.query(plan.g1[0].kind,plan.g1[0].input),retrievalIndexMs=service.metrics.retrievalIndexMs;
 for(let i=1;i<HOT_GRAPH_THRESHOLDS.warmups;i++){const q=plan.g1[i%plan.g1.length];await service.query(q.kind,q.input);}
 const round=[],query=[],responseBytes=[],nodes=[],edges=[],truncated=[],errors=[];const rss=[];
 for(let i=0;i<HOT_GRAPH_THRESHOLDS.measuredRequests;i++){const q=plan.g1[i%plan.g1.length],before=service.metrics.queryMs,start=performance.now();const page=await service.query(q.kind,q.input);round.push(performance.now()-start);query.push(service.metrics.queryMs-before);responseBytes.push(bytes(page));nodes.push(page.items?.length??0);edges.push(page.edges?.length??0);truncated.push(page.truncated===true);rss.push(process.memoryUsage().rss);if(page.status==='error')errors.push({i,warnings:page.warnings});}
 const generationId=service.metrics.generationId,workerStarts=service.metrics.workerStarts,protocol={buildMs:service.metrics.buildMs,extractedFiles:service.metrics.extractedFiles,resolvedFiles:service.metrics.resolvedFiles,resumedFiles:service.metrics.resumedFiles,resumedResolutionFiles:service.metrics.resumedResolutionFiles,coldRequests:service.metrics.coldRequestMs.length};await service.dispose();
 return {initialization:{retrievalIndexMs,firstResponseBytes:bytes(first)},roundTripMs:quantiles(round),queryMs:quantiles(query),responseBytes:quantiles(responseBytes),nodesReturned:quantiles(nodes),edgesReturned:quantiles(edges),truncated:truncated.filter(Boolean).length,errors,workerStarts,generationId,memory:{rssStart:rss[0],rssEnd:rss.at(-1),rssMax:Math.max(...rss),longestMonotonicIncrease:longestIncrease(rss)},protocol};
}
const hotOk=x=>x.protocol.buildMs===0&&x.protocol.extractedFiles===0&&x.protocol.resolvedFiles===0&&x.protocol.resumedFiles===0&&x.protocol.resumedResolutionFiles===0&&x.protocol.coldRequests===0&&!x.errors.length&&x.workerStarts<=HOT_GRAPH_THRESHOLDS.maxWorkerStarts&&x.memory.longestMonotonicIncrease<HOT_GRAPH_THRESHOLDS.maxMonotonicMemorySamples;
async function main(){
 const cache=resolve(get('--cache')),state=resolve(get('--state')),output=resolve(get('--output'));await mkdir(output,{recursive:true});
 const prepared=[];for(const task of await tasks()){const adapter=new RealCorpusAdapter({cache,stateDir:join(state,task.case_id),configuration:{graphProfileVersion:1}}),materialized=await adapter.materialize(task,{offline:true});prepared.push({caseId:task.case_id,repository:task.repository,...materialized});}
 const receipt=await prepareGraphCases(prepared,{kind:'benchmark',output:join(output,'graph-preparation.json')});const results=[];
 for(const item of prepared){const opened=await SqliteCodeGraph.openPublishedOnly(item.store);opened.graph.close();const data=graphData(await publishedGraphPath(item.store.stateDir,item.store.manifest.identity.id),item.store.manifest.identity.id),plan=queryPlan(item.store,data.entities,data.relations),g0=await benchmarkG0(item.store,plan),g1=await benchmarkG1(item.store,plan),expected=receipt.entries.find(x=>x.caseId===item.caseId).generationId;
  const pass=hotOk(g0)&&hotOk(g1)&&g0.generationId===expected&&g1.generationId===expected&&g0.roundTripMs.p95<=HOT_GRAPH_THRESHOLDS.g0P95Ms&&g0.roundTripMs.max<=HOT_GRAPH_THRESHOLDS.g0MaxMs&&g1.roundTripMs.p95<=HOT_GRAPH_THRESHOLDS.g1P95Ms&&g1.roundTripMs.max<=HOT_GRAPH_THRESHOLDS.g1MaxMs;results.push({caseId:item.caseId,repository:item.repository,snapshotId:item.store.manifest.identity.id,generationId:expected,generationState:opened.manifest.generationState,g0,g1,pass});
 }
 const report={schemaVersion:1,kind:'hot-graph-acceptance',scheme:'A',coldConstruction:'intentionally excluded by v0.2 Scheme A',thresholds:HOT_GRAPH_THRESHOLDS,graphPreparationSha256:receipt.graphPreparationSha256,results,pass:results.every(x=>x.pass),finishedAt:new Date().toISOString()};
 await writeFile(join(output,'hot-graph-acceptance.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 const lines=['# Hot Graph acceptance','','Cold construction intentionally excluded by v0.2 Scheme A.','',`Overall: **${report.pass?'PASS':'FAIL'}**`,'','| Repo | Graph state | G0 p50 | G0 p95 | G0 max | G1 index ms | G1 p50 | G1 p95 | Errors |','|---|---|---:|---:|---:|---:|---:|---:|---:|',...results.map(x=>`| ${x.repository} | ${x.generationState} | ${x.g0.roundTripMs.p50.toFixed(2)} | ${x.g0.roundTripMs.p95.toFixed(2)} | ${x.g0.roundTripMs.max.toFixed(2)} | ${x.g1.initialization.retrievalIndexMs.toFixed(2)} | ${x.g1.roundTripMs.p50.toFixed(2)} | ${x.g1.roundTripMs.p95.toFixed(2)} | ${x.g0.errors.length+x.g1.errors.length} |`),'','Historical cold-build engineering data remains in docs/VALIDATION.md and is not a release blocker.',''];
 await writeFile(join(output,'hot-graph-acceptance.md'),lines.join('\n'),{flag:'wx'});console.log(JSON.stringify({output,pass:report.pass,results:results.length}));if(!report.pass)process.exitCode=1;
}
await main();
