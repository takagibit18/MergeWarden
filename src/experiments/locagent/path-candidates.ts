import {classifyPythonPath} from '../../graph/scope-policy.ts';
import type {SymbolFact} from '../../graph/contracts.ts';
import {MAX_PATHS_PER_CANDIDATE} from './path-retention.ts';
import type {RetainedGraph,RetainedPath} from './path-retention.ts';
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export interface CandidateUnit {snapshotId:string;generationId:string;terminalEntity:SymbolFact;retainedPaths:RetainedPath[];bestPath:RetainedPath;depth:number;terminalPath:string}
export interface CandidateContext {changedPaths:readonly string[];seenPaths:readonly string[];rootPaths:readonly string[]}
const comparePath=(a:RetainedPath,b:RetainedPath)=>b.depth-a.depth||cmp(a.patternId,b.patternId)||cmp(JSON.stringify(a.edgeIds),JSON.stringify(b.edgeIds));
/** Construct after the complete replay; discovery/arrival order never reserves a source slot. */
export function candidateUnits(graph:RetainedGraph):CandidateUnit[]{
 const grouped=new Map<string,{entity:SymbolFact;paths:RetainedPath[]}>();
 for(const s of graph.states){
  if(s.entity.id===s.rootEntityId||!s.paths.length||!['file','class','function'].includes(s.entity.kind)||!s.entity.path||!Number.isInteger(s.entity.startLine)||s.entity.startLine<1||s.entity.endLine<s.entity.startLine)continue;
  let entry=grouped.get(s.entity.id);if(!entry){entry={entity:s.entity,paths:[]};grouped.set(s.entity.id,entry);}entry.paths.push(...s.paths);
 }
 return [...grouped.values()].map(({entity,paths})=>{
  const unique=[...new Map(paths.map(p=>[JSON.stringify([p.patternId,p.edgeIds]),p])).values()].sort(comparePath),retained:RetainedPath[]=[],patterns=new Set<string>();
  for(const p of unique)if(!patterns.has(p.patternId)&&retained.length<MAX_PATHS_PER_CANDIDATE){retained.push(p);patterns.add(p.patternId);}
  for(const p of unique)if(retained.length<MAX_PATHS_PER_CANDIDATE&&!retained.includes(p))retained.push(p);
  retained.sort(comparePath);const bestPath=retained[0]!;
  return {snapshotId:graph.snapshotId,generationId:graph.generationId,terminalEntity:entity,retainedPaths:retained,bestPath,depth:bestPath.depth,terminalPath:entity.path};
 }).sort((a,b)=>cmp(a.terminalPath,b.terminalPath)||a.terminalEntity.startLine-b.terminalEntity.startLine||cmp(a.terminalEntity.id,b.terminalEntity.id));
}
export function selectPathCandidates(units:readonly CandidateUnit[],context:CandidateContext){
 const seen=new Set(context.seenPaths),changed=new Set(context.changedPaths),roots=new Set(context.rootPaths),stratum=(u:CandidateUnit)=>Math.min(3,u.depth);
 const untouchedProduction=(u:CandidateUnit)=>!changed.has(u.terminalPath)&&classifyPythonPath(u.terminalPath)==='production';
 const compare=(a:CandidateUnit,b:CandidateUnit)=>Number(seen.has(a.terminalPath))-Number(seen.has(b.terminalPath))
  ||Number(!untouchedProduction(a))-Number(!untouchedProduction(b))||Number(roots.has(a.terminalPath))-Number(roots.has(b.terminalPath))
  ||b.depth-a.depth||cmp(a.terminalPath,b.terminalPath)||a.terminalEntity.startLine-b.terminalEntity.startLine||cmp(a.terminalEntity.id,b.terminalEntity.id);
 const remaining=[...units].sort(compare),selected:CandidateUnit[]=[],files=new Set<string>(),patterns=new Set<string>(),depths=new Set<number>();
 const take=(u:CandidateUnit)=>{selected.push(u);files.add(u.terminalPath);patterns.add(u.bestPath.patternId);depths.add(stratum(u));remaining.splice(remaining.indexOf(u),1);};
 const deepest=Math.max(0,...remaining.map(u=>u.depth));if(deepest>=2)take(remaining.filter(u=>u.depth===deepest).sort(compare)[0]!);
 while(selected.length<3&&remaining.length){
  remaining.sort((a,b)=>Number(files.has(a.terminalPath))-Number(files.has(b.terminalPath))
    ||Number(patterns.has(a.bestPath.patternId))-Number(patterns.has(b.bestPath.patternId))
    ||Number(depths.has(stratum(a)))-Number(depths.has(stratum(b)))||compare(a,b));take(remaining[0]!);
 }
 return {selected,omitted:remaining,diversity:{files:files.size,patterns:patterns.size,depthStrata:depths.size},deepestAvailable:deepest,deepSlotReserved:deepest>=2};
}
