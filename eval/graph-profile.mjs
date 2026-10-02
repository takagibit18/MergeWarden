import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RealCorpusAdapter} from './real/cache.mjs';
import {SqliteCodeGraph,graphBuildAudit,publishedGraphPath,readGraphEntities,readGraphRelations} from '../src/graph/sqlite-store.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {writeJson} from '../src/infrastructure/files.ts';

const selected=['RG2-9a9c0b930264','RG2-36fc7cf7f8d0','RG-C035','RG-C008','RG2-8a20ce3c59fd','RG2-1f682ac2d7bb','RG2-7b899db872f4','RG2-ae0ac5357175'];
const keyChecks={
 'RG2-8a20ce3c59fd':{from:'where',to:'merge_attrs',maxHops:6},
 'RG2-7b899db872f4':{from:'ratsimpmodprime',to:'solve',maxHops:3},
};
const get=(name,required=true)=>{const i=process.argv.indexOf(name),value=i>=0?process.argv[i+1]:undefined;if(required&&!value)throw Error(`Missing ${name}`);return value;};
const jsonl=async path=>(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const memory=()=>{const m=process.memoryUsage();return {rssBytes:m.rss,heapUsedBytes:m.heapUsed,externalBytes:m.external,arrayBuffersBytes:m.arrayBuffers};};
const maxMemory=(a,b)=>Object.fromEntries(Object.keys(a).map(key=>[key,Math.max(a[key],b[key])]));
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;return {count:values.length,minMs:sorted[0]??0,meanMs:values.reduce((a,b)=>a+b,0)/(values.length||1),p50Ms:at(.5),p95Ms:at(.95),maxMs:sorted.at(-1)??0};};
function relationPath(entities,relations,check){
 const byId=new Map(entities.map(entity=>[entity.id,entity])),starts=entities.filter(entity=>entity.name===check.from),targets=new Set(entities.filter(entity=>entity.name===check.to).map(entity=>entity.id));
 const outgoing=new Map();for(const edge of relations.filter(edge=>edge.relation==='CALLS'))outgoing.set(edge.fromId,[...outgoing.get(edge.fromId)??[],edge]);
 const queue=starts.map(entity=>({id:entity.id,path:[]})),seen=new Map(starts.map(entity=>[entity.id,0]));
 while(queue.length){const current=queue.shift();if(targets.has(current.id)&&current.path.length)return current.path.map(edge=>({from:byId.get(edge.fromId)?.qualifiedName,to:byId.get(edge.toId)?.qualifiedName,relation:edge.relation,resolution:edge.resolution,sourcePath:edge.sourcePath,sourceLine:edge.sourceLine,siteCount:edge.siteCount}));if(current.path.length>=check.maxHops)continue;
  for(const edge of outgoing.get(current.id)??[]){const depth=current.path.length+1;if((seen.get(edge.toId)??Infinity)<=depth)continue;seen.set(edge.toId,depth);queue.push({id:edge.toId,path:[...current.path,edge]});}
 }
 return [];
}
function dbStats(path,snapshotId){
 const db=new DatabaseSync(path,{readOnly:true});try{
  const counts=(sql)=>Object.fromEntries(db.prepare(sql).all(snapshotId).map(row=>[String(row.kind??row.site_kind??row.classification),Number(row.n)]));
  const meta=db.prepare('SELECT generation_id,state,graph_scope,coverage,warnings FROM graph_snapshots WHERE snapshot_id=?').get(snapshotId);
  const entities=readGraphEntities(db,snapshotId),relations=readGraphRelations(db,snapshotId);
  return {meta:{generationId:String(meta.generation_id),state:String(meta.state),scope:String(meta.graph_scope),coverage:JSON.parse(String(meta.coverage)),warnings:JSON.parse(String(meta.warnings))},entities,relations,
   counts:{entities:counts('SELECT kind,count(*) n FROM entities WHERE snapshot_id=? GROUP BY kind'),sites:counts('SELECT site_kind,count(*) n FROM dependency_sites WHERE snapshot_id=? GROUP BY site_kind'),relations:counts('SELECT kind,count(*) n FROM relations WHERE snapshot_id=? GROUP BY kind'),files:counts('SELECT classification,count(*) n FROM files WHERE snapshot_id=? GROUP BY classification'),relationSites:Number(db.prepare('SELECT count(*) n FROM relation_sites WHERE snapshot_id=?').get(snapshotId).n)},
   candidateSites:Number(db.prepare("SELECT count(*) n FROM dependency_sites WHERE snapshot_id=? AND resolution='candidate'").get(snapshotId).n),unresolvedSites:Number(db.prepare("SELECT count(*) n FROM dependency_sites WHERE snapshot_id=? AND resolution='unresolved'").get(snapshotId).n)};
 }finally{db.close();}
}
async function scopeProfile(store,scope){
 let peak=memory();const timer=setInterval(()=>{peak=maxMemory(peak,memory());},25);const wallStart=performance.now();let opened;
 try{opened=await SqliteCodeGraph.open(store,{scope});peak=maxMemory(peak,memory());}finally{clearInterval(timer);}
 const coldWallMs=performance.now()-wallStart,first=opened;first.graph.close();const reopenStart=performance.now();const reopened=await SqliteCodeGraph.open(store,{scope});const firstOpenMs=performance.now()-reopenStart;
 const queryMs=[];for(let i=0;i<25;i++){const start=performance.now();await reopened.graph.lookup({snapshotId:store.manifest.identity.id,query:'/',limit:10});queryMs.push(performance.now()-start);}reopened.graph.close();
 const path=await publishedGraphPath(store.stateDir,store.manifest.identity.id,undefined,scope),stats=dbStats(path,store.manifest.identity.id),audit=await graphBuildAudit(store.stateDir,store.manifest.identity.id,undefined,scope);
 const rawFacts=audit.files.reduce((sum,row)=>sum+row.factCount,0),retained=Object.values(stats.counts.entities).reduce((a,b)=>a+b,0)+Object.values(stats.counts.sites).reduce((a,b)=>a+b,0)+Object.values(stats.counts.relations).reduce((a,b)=>a+b,0)+stats.counts.relationSites;
 return {scope,generationId:stats.meta.generationId,state:stats.meta.state,coverage:stats.meta.coverage,counts:stats.counts,candidateSites:stats.candidateSites,unresolvedSites:stats.unresolvedSites,rawExtractionFacts:rawFacts,retainedRows:retained,storage:first.metrics.storage,coldBuildMs:first.metrics.buildMs,coldWallMs,firstOpenMs,hotQueries:summary(queryMs),buildProgress:{extractedFiles:first.metrics.extractedFiles,resumedFiles:first.metrics.resumedFiles,resolvedFiles:first.metrics.resolvedFiles,resumedResolutionFiles:first.metrics.resumedResolutionFiles},sampledProcessMemory:{peak,end:memory()},path,entities:stats.entities,relations:stats.relations};
}
async function contentProfile(store,profile){
 const sources={};let sourceBytes=0;const before=memory();for(const path of new Set(profile.entities.filter(entity=>entity.kind==='file').map(entity=>entity.path))){const text=await store.text('head',path);sources[path]=text;sourceBytes+=Buffer.byteLength(text);}
 const loaded=memory(),start=performance.now();const retrieval=new LocAgentRetrieval({snapshotId:store.manifest.identity.id,generationId:profile.generationId,generationState:profile.state,graphScope:'core',symbols:profile.entities,relations:profile.relations,sources,coverage:profile.coverage,warnings:[]});const indexMs=performance.now()-start,after=memory();
 return {sourceBytes,indexMs,...retrieval.stats(),memory:{before,sourcesLoaded:loaded,indexed:after,heapDeltaBytes:after.heapUsedBytes-before.heapUsedBytes,rssDeltaBytes:after.rssBytes-before.rssBytes}};
}
async function tasks(){
 const publicTasks=await jsonl(new URL('./real/corpora/mergewarden-real-python40-v1/public/tasks.jsonl',import.meta.url));const byId=new Map(publicTasks.map(task=>[task.case_id,task]));
 const closure=JSON.parse(await readFile(new URL('./real/manifests/closure-index.json',import.meta.url),'utf8'));for(const row of closure.records)if(selected.includes(row.candidateId))byId.set(row.candidateId,{case_id:row.candidateId,repository:row.repository,repository_url:`https://github.com/${row.repository}.git`,base_sha:row.profile.baseSha,reviewed_sha:row.profile.reviewedSha,language:'Python',review_context_policy:'repository'});
 return selected.map(id=>{const task=byId.get(id);if(!task)throw Error(`Selected task missing from pinned manifests: ${id}`);return task;});
}
async function main(){
 const cache=resolve(get('--cache')),stateRoot=resolve(get('--state')),output=resolve(get('--output')),only=get('--case',false),offline=process.argv.includes('--offline');let report={schemaVersion:1,implementation:{graphSchema:4,resolver:'python-entities-streaming-5',scopePolicy:'python-core-scope-2',defaultBudget:{maxFacts:250000,maxRelations:400000,maxFileFacts:25000,maxFileMs:15000}},selectedCaseIds:selected,startedAt:new Date().toISOString(),results:[]};
 try{report=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const task of await tasks()){
  if(only&&task.case_id!==only||report.results.some(row=>row.caseId===task.case_id&&row.status==='measured'))continue;const record={caseId:task.case_id,repository:task.repository,baseSha:task.base_sha,reviewedSha:task.reviewed_sha,status:'running',startedAt:new Date().toISOString()};report.results=report.results.filter(row=>row.caseId!==task.case_id);report.results.push(record);await writeJson(output,report);
  try{
   const adapter=new RealCorpusAdapter({cache,stateDir:join(stateRoot,task.case_id),configuration:{graphProfileVersion:1}}),{store}=await adapter.materialize(task,{offline});record.snapshotId=store.manifest.identity.id;record.changedPaths=store.manifest.changedPaths;
   const core=await scopeProfile(store,'core'),all=await scopeProfile(store,'all');record.core={...core,entities:undefined,relations:undefined};record.all={...all,entities:undefined,relations:undefined};record.layeringDelta={files:all.coverage.indexedFiles-core.coverage.indexedFiles,rawExtractionFacts:all.rawExtractionFacts-core.rawExtractionFacts,entities:Object.values(all.counts.entities).reduce((a,b)=>a+b,0)-Object.values(core.counts.entities).reduce((a,b)=>a+b,0),sites:Object.values(all.counts.sites).reduce((a,b)=>a+b,0)-Object.values(core.counts.sites).reduce((a,b)=>a+b,0),relations:Object.values(all.counts.relations).reduce((a,b)=>a+b,0)-Object.values(core.counts.relations).reduce((a,b)=>a+b,0),generationBytes:all.storage.generationBytes-core.storage.generationBytes,checkpointBytes:all.storage.checkpointBytes-core.storage.checkpointBytes};record.contentIndex=await contentProfile(store,core);
   const check=keyChecks[task.case_id];record.keyCallPath=check?{request:check,path:relationPath(core.entities,core.relations,check)}:null;const byId=new Map(core.entities.map(entity=>[entity.id,entity])),inheritance=core.relations.find(edge=>edge.relation==='INHERITS');record.inheritanceSample=inheritance?{child:byId.get(inheritance.fromId)?.qualifiedName,parent:byId.get(inheritance.toId)?.qualifiedName,sourcePath:inheritance.sourcePath,sourceLine:inheritance.sourceLine,resolution:inheritance.resolution,declarationOrder:inheritance.declarationOrder}:null;record.callSamples=core.relations.filter(edge=>edge.relation==='CALLS').slice(0,20).map(edge=>({caller:byId.get(edge.fromId)?.qualifiedName,callee:byId.get(edge.toId)?.qualifiedName,sourcePath:edge.sourcePath,sourceLine:edge.sourceLine,resolution:edge.resolution,siteCount:edge.siteCount}));record.status='measured';record.finishedAt=new Date().toISOString();
  }catch(error){record.status='failed';record.error=error instanceof Error?error.message:String(error);record.finishedAt=new Date().toISOString();}
  await writeJson(output,report);global.gc?.();
 }
 report.finishedAt=new Date().toISOString();await writeJson(output,report);
}
await main();
