import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {emptyCoverage} from '../../graph/contracts.ts';
import {releaseGraphBuildLock} from '../../graph/sqlite-store.ts';
import type {GraphMetrics} from '../../graph/sqlite-store.ts';
import type {RetrievalConfig} from './contracts.ts';
import {SEARCH_SCHEMA,TRAVERSE_SCHEMA} from './contracts.ts';
type Result={id:number;page?:Record<string,unknown>;metrics?:GraphMetrics;retrievalIndexMs?:number;error?:string};
/** One bounded retrieval service per review; verified graph and sparse indexes are reused. */
export class LazyLocAgent {
 private stateDir:string;private snapshotId:string;private config:RetrievalConfig;private preparedOnly:boolean;private worker:Worker|undefined;private ownerToken=randomUUID();private sequence=0;private closed=false;
 private pending=new Map<number,{resolve(value:Result):void;reject(error:unknown):void}>();
 metrics={buildMs:0,queryMs:0,retrievalIndexMs:0,warmRequestMs:[] as number[],coldRequestMs:[] as number[],calls:0,workerStarts:0,coverage:emptyCoverage(),resumedFiles:0,extractedFiles:0,resumedResolutionFiles:0,resolvedFiles:0,storage:{generationBytes:0,checkpointBytes:0},generationId:undefined as GraphMetrics['generationId'],generationState:undefined as GraphMetrics['generationState'],scope:undefined as GraphMetrics['scope']};
 constructor(stateDir:string,snapshotId:string,config:RetrievalConfig={},options:{preparedOnly?:boolean}={}){this.stateDir=stateDir;this.snapshotId=snapshotId;this.config=config;this.preparedOnly=options.preparedOnly===true;}
 definitions(){return [
  ...(this.config.searchEntityEnabled===false?[]:[{name:'search_entity',description:'Locate candidate HEAD entities when the exact graph symbol is not already known, especially when a review question may depend on untouched repository code. Supports exact names or IDs, sparse entity and content retrieval, and a final fuzzy fallback. Use results to choose focused structural exploration; candidates and previews are not behavioral proof. Verify relevant code with read_source.',schema:SEARCH_SCHEMA}]),
  ...(this.config.traverseEnabled===false?[]:[{name:'traverse_graph',description:'Explore bounded definite structural paths from located entities. upstream follows incoming calls, imports, inheritance, or containment; downstream follows outgoing dependencies. both considers both directions at each visited entity. Ordinary identifier references are not indexed. Use focused roots, relation filters, and small hop counts first to discover untouched or otherwise relevant code. Hops are bounded to 1..20 and empty filters include all existing types. Verify relevant results with read_source.',schema:TRAVERSE_SCHEMA}])
 ];}
 private start(){
  if(this.closed)throw Error('Retrieval service is closed');if(this.worker)return this.worker;
  this.metrics.workerStarts++;
  const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:{stateDir:this.stateDir,snapshotId:this.snapshotId,config:this.config,ownerToken:this.ownerToken,preparedOnly:this.preparedOnly},execArgv:['--experimental-strip-types'],resourceLimits:{maxOldGenerationSizeMb:512}});
  worker.on('message',(value:Result)=>{const request=this.pending.get(value.id);if(!request)return;this.pending.delete(value.id);request.resolve(value);if(!this.pending.size)worker.unref();});
  const failed=(error:unknown)=>{for(const request of this.pending.values())request.reject(error);this.pending.clear();if(this.worker===worker)this.worker=undefined;};
  worker.once('error',()=>failed(Error('Retrieval worker failed')));worker.once('exit',code=>{if(code!==0||this.pending.size)failed(Error('Retrieval worker exited before a verified result'));if(this.worker===worker)this.worker=undefined;});worker.unref();this.worker=worker;return worker;
 }
 private async stop(reason:unknown){const worker=this.worker;this.worker=undefined;for(const request of this.pending.values())request.reject(reason);this.pending.clear();if(worker){worker.ref();await worker.terminate().catch(()=>undefined);}await releaseGraphBuildLock(this.stateDir,this.snapshotId,this.ownerToken).catch(()=>undefined);}
 async query(method:string,input:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>{
  signal?.throwIfAborted();const started=performance.now();this.metrics.calls++;const id=++this.sequence,worker=this.start();
  const result=await new Promise<Result>((resolve,reject)=>{let settled=false;const ok=(value:Result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);resolve(value);};const fail=(error:unknown)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);reject(error);};const cancel=()=>{this.pending.delete(id);const reason=signal?.reason??Error('Retrieval cancelled');void this.stop(reason).finally(()=>fail(reason));};this.pending.set(id,{resolve:ok,reject:fail});worker.ref();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();else worker.postMessage({id,method,input});});
  signal?.throwIfAborted();
  if(result.metrics){this.metrics.buildMs+=result.metrics.buildMs;this.metrics.queryMs+=result.metrics.queryMs;this.metrics.retrievalIndexMs+=result.retrievalIndexMs??0;this.metrics.coverage=result.metrics.coverage;this.metrics.resumedFiles+=result.metrics.resumedFiles;this.metrics.extractedFiles+=result.metrics.extractedFiles;this.metrics.resumedResolutionFiles+=result.metrics.resumedResolutionFiles;this.metrics.resolvedFiles+=result.metrics.resolvedFiles;this.metrics.storage=result.metrics.storage;this.metrics.generationId=result.metrics.generationId;this.metrics.generationState=result.metrics.generationState;this.metrics.scope=result.metrics.scope;(result.metrics.cacheHit?this.metrics.warmRequestMs:this.metrics.coldRequestMs).push(performance.now()-started);}
  return result.page??{status:'error',snapshotId:this.snapshotId,revision:'head',items:[],truncated:false,coverage:result.metrics?.coverage??emptyCoverage(),warnings:[result.error??'Retrieval failed','Empty results do not establish absence.'],explorationOnly:true};
 }
 async dispose(){if(this.closed)return;this.closed=true;await this.stop(Error('Retrieval service closed'));}
}
