import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {SnapshotStore} from '../../snapshot/store.ts';
import {emptyCoverage} from '../../graph/contracts.ts';
import {GraphOpenError,SqliteCodeGraph,publishedGraphPath,readGraphEntities,readGraphRelations} from '../../graph/sqlite-store.ts';
import type {GraphMetrics} from '../../graph/sqlite-store.ts';
import {LocAgentRetrieval} from './retrieval.ts';
let retrieval:LocAgentRetrieval|undefined,metrics:GraphMetrics|undefined,indexMs=0,first=true;let queue=Promise.resolve();
async function initialize(){
 const initializationStarted=performance.now();
 const store=await SnapshotStore.load(workerData.stateDir,workerData.snapshotId);const opened=workerData.preparedOnly?await SqliteCodeGraph.openPublishedOnly(store):await SqliteCodeGraph.open(store,{ownerToken:workerData.ownerToken});metrics=opened.metrics;
 try{
  const db=new DatabaseSync(await publishedGraphPath(workerData.stateDir,workerData.snapshotId),{readOnly:true});
  try{const id=store.manifest.identity.id;const symbols=readGraphEntities(db,id);const relations=readGraphRelations(db,id);const meta=db.prepare('SELECT warnings,generation_id,state,graph_scope FROM graph_snapshots WHERE snapshot_id=?').get(id)!;const sources:Record<string,string>={};for(const path of new Set(symbols.filter(s=>s.kind==='file').map(s=>s.path)))sources[path]=await store.text('head',path);retrieval=new LocAgentRetrieval({snapshotId:id,generationId:String(meta.generation_id),generationState:String(meta.state) as 'ready'|'partial',graphScope:String(meta.graph_scope) as 'core'|'all',symbols,relations,sources,coverage:metrics.coverage,warnings:JSON.parse(String(meta.warnings))},workerData.config);indexMs=performance.now()-initializationStarted;}finally{db.close();}
 }finally{opened.graph.close();}
}
async function handle(message:{id:number;method:string;input:any}){
 try{if(!retrieval)await initialize();const started=performance.now();let page;try{page=message.method==='resolve_change_units'?retrieval!.resolveChangeUnits(message.input):message.method==='host_structural_investigation'?retrieval!.investigate(message.input):message.method==='search_entity'?retrieval!.search(message.input):message.method==='locate_entity'?retrieval!.locate(message.input):message.method==='host_traverse_graph'?retrieval!.hostTraverse(message.input):message.method==='traverse_graph'?retrieval!.traverse(message.input):(()=>{throw Error('Unknown retrieval operation')})();}catch(error){page={status:'error',snapshotId:workerData.snapshotId,revision:'head',items:[],truncated:false,coverage:metrics!.coverage,warnings:[error instanceof Error?error.message:'Retrieval query failed','Empty results do not establish absence.'],explorationOnly:true};}const value:GraphMetrics=first?{...metrics!,queryMs:performance.now()-started}:{...metrics!,buildMs:0,queryMs:performance.now()-started,cacheHit:true,resumedFiles:0,extractedFiles:0,resumedResolutionFiles:0,resolvedFiles:0};parentPort!.postMessage({id:message.id,page,metrics:value,retrievalIndexMs:first?indexMs:0});first=false;}
 catch(error){if(error instanceof GraphOpenError)parentPort!.postMessage({id:message.id,page:{status:error.status,snapshotId:workerData.snapshotId,revision:'head',items:[],truncated:false,coverage:error.coverage,warnings:error.warnings,explorationOnly:true},metrics:{buildMs:0,queryMs:0,cacheHit:false,coverage:error.coverage,resumedFiles:0,extractedFiles:0,resumedResolutionFiles:0,resolvedFiles:0,storage:{generationBytes:0,checkpointBytes:0}}});else parentPort!.postMessage({id:message.id,page:{status:'error',snapshotId:workerData.snapshotId,revision:'head',items:[],truncated:false,coverage:metrics?.coverage??emptyCoverage(),warnings:[error instanceof Error?error.message:'LocAgent retrieval failed'],explorationOnly:true}});}
}
parentPort!.on('message',message=>{queue=queue.then(()=>handle(message));});
