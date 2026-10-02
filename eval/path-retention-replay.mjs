import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {explanationStateId} from '../src/experiments/locagent/path-retention.ts';
/** Convert frozen evidence of exploration, without opening a graph or source store. */
export function retentionTraceFromFrozen(row,plan,inspection){
 const root=plan.queries[0].startEntities[0],symbols=new Map(row.searches.flatMap(s=>s.discoveries.map(d=>[d.entity.id,d.entity]))),states=new Map(),links=[];
 const add=(entity,patternId,stepIndex,direction)=>{const s={entity,rootEntityId:root,patternId,stepIndex,direction},id=explanationStateId(s);states.set(id,s);return id;};
 const link=(previousStateId,stateId,edge,direction)=>links.push({previousStateId,stateId,edge,direction});
 let inferredLaneLinks=0;
 if(plan.request.template==='STRUCTURAL_ESCALATION'){
  const byTuple=new Map();
  for(const d of row.searches[0].discoveries){const p=STRUCTURAL_PATTERNS.find(p=>p.id===d.patternId);if(!p)throw Error('Unknown frozen pattern');const dir=(p.steps[d.depth]??p.steps.at(-1)).direction,id=add(d.entity,d.patternId,d.depth,dir);byTuple.set(JSON.stringify([d.entity.id,d.patternId,d.depth]),id);}
  for(const v of inspection.visits)for(const [priorId,s] of states){
   const rule=STRUCTURAL_PATTERNS.find(p=>p.id===s.patternId).steps[s.stepIndex];if(s.entity.id!==v.fromStateEntity||!rule||rule.direction!==v.direction||!rule.relations.includes(v.edge.relation))continue;
   const nextId=v.direction==='downstream'?v.edge.toId:v.edge.fromId,next=byTuple.get(JSON.stringify([nextId,s.patternId,s.stepIndex+1]));
   if(next&&['resolved_scoped','resolved_import_alias'].includes(v.edge.resolution)){link(priorId,next,v.edge,v.direction);inferredLaneLinks++;}
  }
 }else if(plan.request.template==='IMPORT_CHECK'){
  const first=row.calls.filter(c=>c.name==='traverse_graph')[0],second=row.calls.filter(c=>c.name==='traverse_graph')[1],rootSymbol=symbols.get(root);
  const exportRoot=add(rootSymbol,'import-consumer',0,'downstream'),directRoot=add(rootSymbol,'import-direct',0,'upstream');
  for(const e of first.result.edges??[]){if(e.fromId!==root||!symbols.has(e.toId))continue;const target=add(symbols.get(e.toId),'import-consumer',1,'upstream');link(exportRoot,target,e,'downstream');for(const edge of second.result.edges??[])if(edge.toId===e.toId&&symbols.has(edge.fromId)){const consumer=add(symbols.get(edge.fromId),'import-consumer',2,'upstream');link(target,consumer,edge,'upstream');}}
  for(const e of second.result.edges??[])if(e.toId===root&&symbols.has(e.fromId)){const consumer=add(symbols.get(e.fromId),'import-direct',1,'upstream');link(directRoot,consumer,e,'upstream');}
 }else{
  for(const [i,search] of row.searches.entries())for(const d of search.discoveries){const direction=plan.queries[i].direction;if(direction==='both')throw Error('Control adapter needs an explicit lane');add(d.entity,plan.request.template,i+d.depth,direction);}
  for(const [i,search]of row.searches.entries())for(const d of search.discoveries)if(d.via&&d.parentStateId!==undefined){const prior=search.discoveries[d.parentStateId],direction=plan.queries[i].direction;link(add(prior.entity,plan.request.template,i+prior.depth,direction),add(d.entity,plan.request.template,i+d.depth,direction),d.via,direction);}
 }
 const input={snapshotId:plan.snapshotId,generationId:plan.generationId,states:[...states.values()],links};
 if(row.pack.snapshotId!==input.snapshotId||row.pack.generationId!==input.generationId)throw Error('Frozen identity mismatch');
 for(const s of input.states)if(!symbols.has(s.entity.id))throw Error('Replay invented a reached entity');
 return {input,inferredLaneLinks,oldReachedEntityIds:[...symbols.keys()],inspectionOrigin:inspection?'frozen supplemental edge inspections':'returned definite edge subset; no new graph access'};
}
