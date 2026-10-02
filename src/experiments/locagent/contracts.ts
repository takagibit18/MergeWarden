import type { GraphCoverage, Relation, RelationFact, SymbolFact } from '../../graph/contracts.ts';
export interface RetrievalConfig {
  searchEntityEnabled?: boolean; bm25Enabled?: boolean; traverseEnabled?: boolean;
  fuzzyEnabled?: boolean; maxHops?: number; sourcePolicy?: 'adaptive'|'preview'|'fold';
  contentIndexByteLimit?: number; contentIndexChunkLimit?: number;
}
export interface GraphData { snapshotId:string; generationId:string; generationState:'ready'|'partial'; graphScope:'core'|'all'; symbols:SymbolFact[]; relations:RelationFact[]; sources:Record<string,string>; coverage:GraphCoverage; warnings:string[] }
export interface SearchInput { searchTerms:string[]; topK:number; filePattern?:string }
export interface TraverseInput { startEntities:string[]; direction:'upstream'|'downstream'|'both'; maxHops:number; entityTypeFilter:SymbolFact['kind'][]; relationTypeFilter:Relation[]; maxNodes:number; maxBytes?:number }
export const LOCAGENT_CAPABILITY_PROMPT = 'G1 structural navigation uses search_entity and traverse_graph over the immutable HEAD snapshot. The graph contains directory, file, class, and function entities connected by CONTAINS, IMPORTS, CALLS, and INHERITS. search_entity locates candidate entities through exact names or IDs, sparse entity and shared file-content retrieval, and a final fuzzy fallback. traverse_graph returns bounded dependency trees; upstream follows incoming definite relations and downstream follows outgoing dependencies. Ordinary identifier references are intentionally not indexed. Relations and coverage may be incomplete. Candidates, previews, scores, and traversal output are exploration only; use read_source for immutable source evidence before submitting findings.';
export const SEARCH_SCHEMA = {type:'object',additionalProperties:false,required:['searchTerms','topK'],properties:{searchTerms:{type:'array',minItems:1,maxItems:5,items:{type:'string',minLength:1,maxLength:256}},topK:{type:'integer',minimum:1,maximum:10},filePattern:{type:'string',minLength:1,maxLength:256}}};
export const TRAVERSE_SCHEMA = {type:'object',additionalProperties:false,required:['startEntities','direction','maxHops','entityTypeFilter','relationTypeFilter','maxNodes'],properties:{startEntities:{type:'array',minItems:1,maxItems:5,items:{type:'string',minLength:1,maxLength:512}},direction:{type:'string',enum:['upstream','downstream','both']},maxHops:{type:'integer',minimum:1,maximum:20},entityTypeFilter:{type:'array',uniqueItems:true,items:{type:'string',enum:['directory','file','class','function']}},relationTypeFilter:{type:'array',uniqueItems:true,items:{type:'string',enum:['CONTAINS','IMPORTS','CALLS','INHERITS']}},maxNodes:{type:'integer',minimum:1,maximum:100},maxBytes:{type:'integer',minimum:2048,maximum:32768}}};

/** Host search work, independent of model-visible delivery bounds. */
export interface ExplorationBudget { maxVisitedNodes:number; maxVisitedEdges:number; maxExpandedStates:number }
