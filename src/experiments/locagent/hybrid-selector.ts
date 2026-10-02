import type {PathCandidate,SelectionContext} from './candidate-set.ts';
import {CANDIDATE_SLOTS} from './candidate-set.ts';
import {duplicateCandidate,relevanceTie,selectRelevance} from './candidate-relevance.ts';
import type {RelevanceRanking} from './candidate-relevance.ts';
export const HYBRID_LAMBDA=0.75;
export function edgeJaccard(a:readonly string[],b:readonly string[]):number{const x=new Set(a),y=new Set(b),u=new Set([...x,...y]);return u.size?[...x].filter(e=>y.has(e)).length/u.size:0;}
export function selectHybrid(pool:readonly PathCandidate[],context:SelectionContext,ranking:RelevanceRanking,patternLengths:Readonly<Record<string,number>>,importOrder:readonly string[]=[]){
  type Row=RelevanceRanking['rows'][number];
  const selected:{candidate:PathCandidate;slot:number;rawBm25:number;normalizedRelevance:number;maxRedundancy:number;diversity:number;mmrScore:number;selectedBecause:string}[]=[],chosen:Row[]=[],rounds:{slot:number;candidates:{candidateId:string;rawBm25:number;normalizedRelevance:number;maxRedundancy:number;diversity:number;mmrScore:number}[]}[]=[];
  const score=(r:Row)=>{const maxRedundancy=Math.max(0,...chosen.map(s=>edgeJaccard(r.coverage.pathEdgeSet,s.coverage.pathEdgeSet))),diversity=1-maxRedundancy;return {candidateId:r.candidate.terminalEntityId,rawBm25:r.rawBm25,normalizedRelevance:r.normalizedRelevance,maxRedundancy,diversity,mmrScore:HYBRID_LAMBDA*r.normalizedRelevance+(1-HYBRID_LAMBDA)*diversity};};
  const take=(r:Row,reason:string)=>{const {candidateId,...s}=score(r);selected.push({candidate:r.candidate,slot:selected.length+1,...s,selectedBecause:reason});chosen.push(r);};
  if(context.route!=='STRUCTURAL_ESCALATION'||ranking.relevanceFallback){
    for(const s of selectRelevance(pool,context,ranking,patternLengths,importOrder).selected)take(ranking.rows.find(r=>r.candidate.terminalEntityId===s.candidate.terminalEntityId)!,s.selectedBecause);
  }else{
    while(selected.length<CANDIDATE_SLOTS){
      const candidates=ranking.rows.filter(r=>!chosen.some(s=>duplicateCandidate(s.candidate,r.candidate)));
      if(!candidates.length)break;
      const scored=candidates.map(row=>({row,score:score(row)}));
      if(chosen.length)scored.sort((a,b)=>b.score.mmrScore-a.score.mmrScore||b.row.rawBm25-a.row.rawBm25||relevanceTie(a.row,b.row,false));
      // First slot keeps the frozen BM25 rank (including its depth tie-break).
      rounds.push({slot:chosen.length+1,candidates:scored.map(s=>s.score)});
      take(scored[0]!.row,chosen.length?'mmr_relevance_diversity':'highest_relevance');
    }
  }
  return {selected,rounds,relevanceFallback:ranking.relevanceFallback,routeDelegated:context.route!=='STRUCTURAL_ESCALATION',candidateSlots:CANDIDATE_SLOTS,lambda:HYBRID_LAMBDA};
}
