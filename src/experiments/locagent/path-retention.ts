import {createHash} from 'node:crypto';
import type {RelationFact,SymbolFact} from '../../graph/contracts.ts';
export const MAX_ALTERNATIVE_PREDECESSORS=2;
export const MAX_PATHS_PER_STATE=2;
export const MAX_PATHS_PER_CANDIDATE=2;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export interface ExplanationStateInput {entity:SymbolFact;rootEntityId:string;patternId:string;stepIndex:number;direction:'upstream'|'downstream'}
export interface ExplanationLink {previousStateId:string;stateId:string;edge:RelationFact;direction:'upstream'|'downstream'}
export interface RetentionTrace {snapshotId:string;generationId:string;states:ExplanationStateInput[];links:ExplanationLink[]}
export interface RetainedPath {stateIds:string[];entityIds:string[];edgeIds:string[];directions:string[];patternId:string;depth:number}
export interface ReachedState extends ExplanationStateInput {stateId:string;predecessorPaths:ExplanationLink[];paths:RetainedPath[]}
export const explanationStateId=(s:ExplanationStateInput)=>createHash('sha256').update(JSON.stringify([s.rootEntityId,s.entity.id,s.patternId,s.stepIndex,s.direction])).digest('hex');
const pathKey=(p:RetainedPath)=>JSON.stringify([p.stateIds,p.edgeIds,p.directions]);
/** Retain explanations over an already frozen trace. No graph access or expansion occurs here. */
export function retainStructuralPaths(trace:RetentionTrace){
 if(!trace.snapshotId||!trace.generationId)throw Error('Frozen snapshot and generation required');
 const byId=new Map<string,ReachedState>();
 for(const input of trace.states){
  if(input.entity.snapshotId!==trace.snapshotId||!Number.isInteger(input.stepIndex)||input.stepIndex<0||input.stepIndex>3)throw Error('Invalid explanation state');
  const stateId=explanationStateId(input),previous=byId.get(stateId);
  if(previous&&JSON.stringify(previous.entity)!==JSON.stringify(input.entity))throw Error('Conflicting entity metadata');
  if(!previous)byId.set(stateId,{...input,stateId,predecessorPaths:[],paths:[]});
 }
 // Bound storage independently from the number of links offered by a diamond-rich trace.
 let duplicateLinks=0,omittedParents=0;const offered=new Map<string,Set<string>>();
 for(const link of trace.links){
  const prior=byId.get(link.previousStateId),next=byId.get(link.stateId),e=link.edge;
  if(!prior||!next||prior.patternId!==next.patternId||prior.rootEntityId!==next.rootEntityId||prior.stepIndex+1!==next.stepIndex)throw Error('Invalid explanation predecessor');
  if(e.snapshotId!==trace.snapshotId||!['resolved_scoped','resolved_import_alias'].includes(e.resolution)
    ||(link.direction==='downstream'?(e.fromId!==prior.entity.id||e.toId!==next.entity.id):(e.toId!==prior.entity.id||e.fromId!==next.entity.id)))throw Error('Invalid definite explanation edge');
  const key=JSON.stringify([link.previousStateId,e.id,e.relation,link.direction]);let keys=offered.get(next.stateId);if(!keys){keys=new Set();offered.set(next.stateId,keys);}if(keys.has(key)){duplicateLinks++;continue;}keys.add(key);
  next.predecessorPaths.push(link);
  next.predecessorPaths.sort((a,b)=>{const x=byId.get(a.previousStateId)!,y=byId.get(b.previousStateId)!;return cmp(x.entity.path,y.entity.path)||cmp(x.entity.qualifiedName,y.entity.qualifiedName)||cmp(x.entity.id,y.entity.id)||cmp(a.edge.id,b.edge.id)||cmp(a.direction,b.direction);});
  if(next.predecessorPaths.length>MAX_ALTERNATIVE_PREDECESSORS){next.predecessorPaths.pop();omittedParents++;}
 }
 const states=[...byId.values()].sort((a,b)=>a.stepIndex-b.stepIndex||cmp(a.stateId,b.stateId));
 for(const s of states){
  if(s.stepIndex===0){if(s.entity.id!==s.rootEntityId)throw Error('Invalid explanation root');s.paths=[{stateIds:[s.stateId],entityIds:[s.entity.id],edgeIds:[],directions:[],patternId:s.patternId,depth:0}];continue;}
  const seen=new Set<string>();
  // One explanation from each parent before considering second explanations from a parent.
  for(let rank=0;rank<MAX_PATHS_PER_STATE&&s.paths.length<MAX_PATHS_PER_STATE;rank++)for(const parent of s.predecessorPaths){
   if(s.paths.length>=MAX_PATHS_PER_STATE)break;const prefix=byId.get(parent.previousStateId)!.paths[rank];if(!prefix)continue;
   const p={stateIds:[...prefix.stateIds,s.stateId],entityIds:[...prefix.entityIds,s.entity.id],edgeIds:[...prefix.edgeIds,parent.edge.id],directions:[...prefix.directions,parent.direction],patternId:s.patternId,depth:s.stepIndex};const key=pathKey(p);if(!seen.has(key)){seen.add(key);s.paths.push(p);}
  }
 }
 const retainedParentLinks=states.reduce((n,s)=>n+s.predecessorPaths.length,0),retainedPaths=states.reduce((n,s)=>n+s.paths.length,0);
 return {snapshotId:trace.snapshotId,generationId:trace.generationId,states,metrics:{reachedEntities:new Set(states.map(s=>s.entity.id)).size,retainedParentLinks,additionalRetainedPredecessors:states.reduce((n,s)=>n+Math.max(0,s.predecessorPaths.length-1),0),retainedPaths,alternativePathCount:states.reduce((n,s)=>n+Math.max(0,s.paths.length-1),0),maxParentsPerState:Math.max(0,...states.map(s=>s.predecessorPaths.length)),retainedPathBytes:Buffer.byteLength(JSON.stringify(states.map(s=>({stateId:s.stateId,parents:s.predecessorPaths,paths:s.paths})))),duplicateLinks,omittedParents}};
}
export type RetainedGraph=ReturnType<typeof retainStructuralPaths>;
