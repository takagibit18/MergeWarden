import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';
import {publishedGraphPath,readGraphEntities,readGraphRelations} from '../src/graph/sqlite-store.ts';
import {LocAgentRetrieval,entityName} from '../src/experiments/locagent/retrieval.ts';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {explanationStateId} from '../src/experiments/locagent/path-retention.ts';
export const hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8')),cmp=(a,b)=>a<b?-1:a>b?1:0;
export async function graphData(c){
 const path=await publishedGraphPath(c.state,c.snapshotId);assert.equal(hash(await readFile(path)),c.graphSha256);assert.equal(hash(await readFile(join(c.state,'snapshots',c.snapshotId+'.json'))),c.snapshotSha256);
 const db=new DatabaseSync(path,{readOnly:true});try{const meta=db.prepare('SELECT * FROM graph_snapshots WHERE snapshot_id=?').get(c.snapshotId);assert.equal(meta.generation_id,c.generationId);return {snapshotId:c.snapshotId,generationId:c.generationId,generationState:meta.state,graphScope:meta.graph_scope,symbols:readGraphEntities(db,c.snapshotId),relations:readGraphRelations(db,c.snapshotId),coverage:JSON.parse(meta.coverage),warnings:JSON.parse(meta.warnings),sources:{}};}finally{db.close();}
}
// Experimental adapter to the existing immutable index; no replacement ordering or rebuilt adjacency.
export function indexed(data){const retrieval=new LocAgentRetrieval(data);return {retrieval,access:{entity:id=>retrieval.byId.get(id),neighbors:(id,dir)=>(dir==='upstream'?retrieval.incomingByEntity:retrieval.outgoingByEntity).get(id)??[],compare:(a,b)=>cmp(entityName(a),entityName(b))||cmp(a.id,b.id)}};}
export function explanation(d,patterns=STRUCTURAL_PATTERNS){const p=patterns.find(p=>p.id===d.patternId);return {entity:d.entity,rootEntityId:d.rootEntityId,patternId:d.patternId,stepIndex:d.depth,direction:(p.steps[d.depth]??p.steps.at(-1)).direction};}
export function exactTelemetry(observations,search,patterns=STRUCTURAL_PATTERNS){
 const states=search.discoveries.map(d=>explanation(d,patterns)),stateIds=states.map(explanationStateId),known=new Map(states.map(s=>[explanationStateId(s),s]));
 const trace=observations.map((e,i)=>{const stateId=explanationStateId(explanation(e.state,patterns)),neighborEntityId=e.edge?(e.direction==='upstream'?e.edge.fromId:e.edge.toId):null;return {schedulerOrdinal:i+1,inspectionOrdinal:e.inspectionOrdinal,patternId:e.state.patternId,stepIndex:e.stepIndex,depth:e.state.depth,direction:e.direction,stateId,parentStateId:e.decision==='REACHED'?(e.state.parentStateId===undefined?null:stateIds[e.state.parentStateId]):stateId,parentEntityId:e.decision==='REACHED'?(e.state.parentStateId===undefined?null:search.discoveries[e.state.parentStateId].entity.id):e.state.entity.id,entityId:e.state.entity.id,neighborEntityId,neighborOrdinal:e.neighborOrdinal??null,edgeId:e.edge?.id??null,edgeRelation:e.edge?.relation??null,decision:e.decision,...(e.edge?{edge:e.edge}:{})};});
 const links=[];
 for(const e of trace.filter(e=>e.decision==='INSPECTED')){const parent=known.get(e.stateId),p=patterns.find(p=>p.id===e.patternId),rule=p.steps[e.stepIndex];if(!rule.relations.includes(e.edge.relation)||!['resolved_scoped','resolved_import_alias'].includes(e.edge.resolution))continue;
  const next=[...known.values()].find(s=>s.entity.id===e.neighborEntityId&&s.rootEntityId===parent.rootEntityId&&s.patternId===e.patternId&&s.stepIndex===e.stepIndex+1);if(next)links.push({previousStateId:e.stateId,stateId:explanationStateId(next),edge:e.edge,direction:e.direction});
 }
 return {trace,input:{states,links},inferredLaneLinks:0};
}
