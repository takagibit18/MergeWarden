import type {PathCandidate,SelectionContext} from './candidate-set.ts';
import {CANDIDATE_SLOTS,selectCandidateSet} from './candidate-set.ts';

const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const union=(values:readonly (readonly string[])[])=>[...new Set(values.flat())].sort(cmp);
export interface CandidateCoverage {
  candidate:PathCandidate;
  pathEdgeSet:string[]; pathStateSet:string[]; pathEntitySet:string[];
  rootBranchSignatures:string[];
  remainingPatternSteps:(number|null)[];
  patternComplete:boolean;
  unknownPatterns:string[];
}
/** Mechanical descriptors over frozen complete paths; no eligibility or provenance changes. */
export function derivePathCoverage(candidate:PathCandidate,patternLengths:Readonly<Record<string,number>>):CandidateCoverage {
  if(candidate.retainedPaths.length<1||candidate.retainedPaths.length>2)throw Error('Expected frozen bounded retained paths');
  const remaining=candidate.retainedPaths.map(p=>{
    const length=patternLengths[p.patternId];
    if(length===undefined)return null;
    if(!Number.isInteger(length)||length<p.depth)throw Error('Invalid frozen pattern length');
    return length-p.depth;
  });
  const branches=candidate.retainedPaths.map((p,i)=>{
    const relation=candidate.relationSequences[i]?.[0],child=p.entityIds[1],direction=p.directions[0];
    if(!relation||!child||!direction||!p.edgeIds.length)throw Error('Incomplete frozen path');
    return JSON.stringify([p.patternId,relation,direction,child]);
  });
  return {candidate,pathEdgeSet:union(candidate.retainedPaths.map(p=>p.edgeIds)),pathStateSet:union(candidate.retainedPaths.map(p=>p.stateIds)),pathEntitySet:union(candidate.retainedPaths.map(p=>p.entityIds)),rootBranchSignatures:union([branches]),remainingPatternSteps:remaining,patternComplete:remaining.some(n=>n===0),unknownPatterns:union([candidate.retainedPaths.filter((_,i)=>remaining[i]===null).map(p=>p.patternId)])};
}
const jaccard=(a:readonly string[],b:readonly string[])=>{const merged=new Set([...a,...b]);return merged.size?a.filter(x=>b.includes(x)).length/merged.size:0;};
export function pathCoverageMetrics(pool:readonly CandidateCoverage[],selected:readonly CandidateCoverage[]){
  const allEdges=union(pool.map(c=>c.pathEdgeSet)),edges=union(selected.map(c=>c.pathEdgeSet)),allBranches=union(pool.map(c=>c.rootBranchSignatures)),branches=union(selected.map(c=>c.rootBranchSignatures)),patterns=union(selected.map(c=>c.candidate.patternIds));
  const overlap=[];
  for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++){
    const a=selected[i]!,b=selected[j]!;overlap.push({first:a.candidate.terminalEntityId,second:b.candidate.terminalEntityId,edgeOverlapJaccard:jaccard(a.pathEdgeSet,b.pathEdgeSet),stateOverlapJaccard:jaccard(a.pathStateSet,b.pathStateSet)});
  }
  return {eligibleStructuralEdges:allEdges.length,selectedCoveredEdges:edges.length,edgeCoverageRatio:allEdges.length?edges.length/allEdges.length:0,eligibleRootBranches:allBranches.length,selectedRootBranches:branches.length,rootBranchCoverageRatio:allBranches.length?branches.length/allBranches.length:0,eligiblePatterns:union(pool.map(c=>c.candidate.patternIds)),selectedPatterns:patterns,selectedPatternCount:patterns.length,coveredEdgeIds:edges,coveredRootBranches:branches,overlap,averageEdgeOverlapJaccard:overlap.length?overlap.reduce((n,p)=>n+p.edgeOverlapJaccard,0)/overlap.length:0,averageStateOverlapJaccard:overlap.length?overlap.reduce((n,p)=>n+p.stateOverlapJaccard,0)/overlap.length:0,pathEdgeAtoms:allEdges.length,pathStateAtoms:union(pool.map(c=>c.pathStateSet)).length,pathEntityAtoms:union(pool.map(c=>c.pathEntitySet)).length,rootBranchAtoms:allBranches.length};
}

export interface CoverageChoice {
  candidate:PathCandidate; coverage:CandidateCoverage; selectedBecause:string;
  marginalEdgeCoverage:number; newEdgeIds:string[]; newRootBranches:string[];
}
/** Fixed-pool greedy coverage with route semantics delegated to the unchanged selector. */
export function selectPathCoverage(pool:readonly PathCandidate[],context:SelectionContext,patternLengths:Readonly<Record<string,number>>,importTemplateOrder:readonly string[]=[]){
  const descriptors=pool.map(c=>derivePathCoverage(c,patternLengths)).sort((a,b)=>cmp(a.candidate.terminalEntityId,b.candidate.terminalEntityId));
  const selected:CoverageChoice[]=[],remaining=[...descriptors],edges=new Set<string>(),branches=new Set<string>();
  const newEdges=(d:CandidateCoverage)=>d.pathEdgeSet.filter(e=>!edges.has(e)),newBranches=(d:CandidateCoverage)=>d.rootBranchSignatures.filter(b=>!branches.has(b));
  const tie=(a:CandidateCoverage,b:CandidateCoverage)=>{
    const x=a.candidate,y=b.candidate;
    return Number(b.patternComplete)-Number(a.patternComplete)||Number(x.alreadyVisible)-Number(y.alreadyVisible)
      ||Number(x.changed||x.classification!=='production')-Number(y.changed||y.classification!=='production')
      ||Math.min(2,y.pathSupportCount)-Math.min(2,x.pathSupportCount)||Number(x.sameRootFile)-Number(y.sameRootFile)
      ||newBranches(b).length-newBranches(a).length||x.depth-y.depth||cmp(x.terminalPath,y.terminalPath)
      ||x.sourceRange.startLine-y.sourceRange.startLine||cmp(x.terminalEntityId,y.terminalEntityId);
  };
  const sameRange=(a:PathCandidate,b:PathCandidate)=>a.terminalPath===b.terminalPath&&a.sourceRange.startLine===b.sourceRange.startLine&&a.sourceRange.endLine===b.sourceRange.endLine;
  const available=()=>remaining.filter(d=>!selected.some(s=>s.candidate.terminalEntityId===d.candidate.terminalEntityId||sameRange(s.candidate,d.candidate)));
  const take=(d:CandidateCoverage,reason:string)=>{
    const added=newEdges(d),novel=newBranches(d);selected.push({candidate:d.candidate,coverage:d,selectedBecause:reason,marginalEdgeCoverage:added.length,newEdgeIds:added,newRootBranches:novel});
    for(const e of added)edges.add(e);for(const b of novel)branches.add(b);remaining.splice(remaining.indexOf(d),1);
  };
  const choose=(choices:CandidateCoverage[],reason:string)=>{if(choices.length&&selected.length<CANDIDATE_SLOTS)take(choices.sort((a,b)=>newEdges(b).length-newEdges(a).length||tie(a,b))[0]!,reason);};
  if(context.route!=='STRUCTURAL_ESCALATION'){
    for(const choice of selectCandidateSet(pool,context,importTemplateOrder).selected){const d=descriptors.find(d=>d.candidate.terminalEntityId===choice.candidate.terminalEntityId)!;take(d,choice.selectedBecause);}
  }else{
    choose(available().filter(d=>d.candidate.depth>=2),'multi_hop_obligation:path_coverage');
    if(!selected.some(s=>!s.candidate.sameRootFile))choose(available().filter(d=>!d.candidate.sameRootFile),'cross_file_obligation:path_coverage');
    while(selected.length<CANDIDATE_SLOTS){const choices=available();if(!choices.length)break;choose(choices,'marginal_edge_coverage');}
  }
  return {selected,omitted:remaining.map(d=>d.candidate.terminalEntityId).sort(cmp),candidateSlots:CANDIDATE_SLOTS,obligations:{applicable:context.route==='STRUCTURAL_ESCALATION',multiHop:context.route!=='STRUCTURAL_ESCALATION'||!pool.some(c=>c.depth>=2)||selected.some(s=>s.candidate.depth>=2),crossFile:context.route!=='STRUCTURAL_ESCALATION'||!pool.some(c=>!c.sameRootFile)||selected.some(s=>!s.candidate.sameRootFile)},metrics:pathCoverageMetrics(descriptors,selected.map(s=>s.coverage))};
}
