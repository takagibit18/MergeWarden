import type {SymbolFact} from '../../graph/contracts.ts';
import type {PathCandidate,SelectionContext} from './candidate-set.ts';
import {CANDIDATE_SLOTS} from './candidate-set.ts';
import {derivePathCoverage,selectPathCoverage} from './path-coverage.ts';
import {lexicalTokens} from './investigation-query.ts';
import {SparseIndex,tokenize} from './sparse.ts';
export type LexicalEntity=Pick<SymbolFact,'id'|'snapshotId'|'name'|'qualifiedName'|'path'>;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function buildCandidateDocuments(pool:readonly PathCandidate[],entities:readonly LexicalEntity[]){
  const byId=new Map(entities.map(e=>[e.id,e]));
  return [...pool].sort((a,b)=>cmp(a.terminalEntityId,b.terminalEntityId)).map(candidate=>{
    const entityIds=[...new Set(candidate.retainedPaths.flatMap(p=>p.entityIds))].sort();
    const metadata=entityIds.map(id=>{const e=byId.get(id);if(!e||e.snapshotId!==candidate.snapshotId)throw Error('Missing frozen path entity');return {id:e.id,name:e.name,qualifiedName:e.qualifiedName,path:e.path};});
    const tokens=[...new Set(metadata.flatMap(e=>lexicalTokens([e.name,e.qualifiedName,e.path].join(' '))))].sort();
    return {candidateId:candidate.terminalEntityId,entityIds,metadata,tokens,text:tokens.join(' '),patterns:candidate.patternIds,relations:[...new Set(candidate.relationSequences.flat())].sort()};
  });
}
export function rankCandidateRelevance(pool:readonly PathCandidate[],entities:readonly LexicalEntity[],query:string,patternLengths:Readonly<Record<string,number>>){
  const documents=buildCandidateDocuments(pool,entities),index=new SparseIndex(documents.map(d=>d.text)),hits=new Map(index.search(query,documents.length).map(h=>[h.index,h.score]));
  const byId=new Map(pool.map(c=>[c.terminalEntityId,c])),queryTerms=new Set(tokenize(query));
  const rows=documents.map((d,i)=>({candidate:byId.get(d.candidateId)!,coverage:derivePathCoverage(byId.get(d.candidateId)!,patternLengths),rawBm25:hits.get(i)??0,matchedTokens:[...new Set(tokenize(d.text).filter(t=>queryTerms.has(t)))].sort()}));
  rows.sort((a,b)=>b.rawBm25-a.rawBm25||relevanceTie(a,b,true));
  const max=rows[0]?.rawBm25??0;
  return {documents,indexStats:index.stats(),rows:rows.map((r,i)=>({...r,rank:i+1,normalizedRelevance:max>0?r.rawBm25/max:0})),relevanceFallback:max<=0};
}
type TieRow={candidate:PathCandidate;coverage:{patternComplete:boolean}};
export function relevanceTie(a:TieRow,b:TieRow,depth:boolean):number{
  const x=a.candidate,y=b.candidate;
  return Number(b.coverage.patternComplete)-Number(a.coverage.patternComplete)||Number(x.alreadyVisible)-Number(y.alreadyVisible)
    ||Number(x.changed||x.classification!=='production')-Number(y.changed||y.classification!=='production')
    ||Math.min(2,y.pathSupportCount)-Math.min(2,x.pathSupportCount)||(depth?x.depth-y.depth:0)
    ||cmp(x.terminalPath,y.terminalPath)||x.sourceRange.startLine-y.sourceRange.startLine||cmp(x.terminalEntityId,y.terminalEntityId);
}
export type RelevanceRanking=ReturnType<typeof rankCandidateRelevance>;
export function duplicateCandidate(a:PathCandidate,b:PathCandidate){return a.terminalEntityId===b.terminalEntityId||(a.terminalPath===b.terminalPath&&a.sourceRange.startLine===b.sourceRange.startLine&&a.sourceRange.endLine===b.sourceRange.endLine);}
export function selectRelevance(pool:readonly PathCandidate[],context:SelectionContext,ranking:RelevanceRanking,patternLengths:Readonly<Record<string,number>>,importOrder:readonly string[]=[]){
  const delegated=context.route!=='STRUCTURAL_ESCALATION'||ranking.relevanceFallback;
  const rows=delegated?selectPathCoverage(pool,context,patternLengths,importOrder).selected.map(s=>({row:ranking.rows.find(r=>r.candidate.terminalEntityId===s.candidate.terminalEntityId)!,reason:context.route!=='STRUCTURAL_ESCALATION'?s.selectedBecause:'structural_fallback'})):ranking.rows.map(row=>({row,reason:'highest_relevance'}));
  const selected:{candidate:PathCandidate;slot:number;rawBm25:number;normalizedRelevance:number;selectedBecause:string}[]=[];
  for(const {row,reason} of rows){if(selected.length>=CANDIDATE_SLOTS)break;if(selected.some(s=>duplicateCandidate(s.candidate,row.candidate)))continue;selected.push({candidate:row.candidate,slot:selected.length+1,rawBm25:row.rawBm25,normalizedRelevance:row.normalizedRelevance,selectedBecause:reason});}
  return {selected,relevanceFallback:ranking.relevanceFallback,routeDelegated:context.route!=='STRUCTURAL_ESCALATION',candidateSlots:CANDIDATE_SLOTS};
}
