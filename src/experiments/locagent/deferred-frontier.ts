import type {SymbolFact,RelationFact} from '../../graph/contracts.ts';
import type {ExplorationBudget} from './contracts.ts';
import type {PatternDiscovery,ProgressiveObservation,TraversalPattern,TraversalStep} from './patterns.ts';
import {explanationStateId} from './path-retention.ts';

interface Cursor {discovery:PatternDiscovery;stateId:string;edges:readonly RelationFact[];nextNeighborIndex:number;turns:number}
interface Lane {pattern:TraversalPattern;queue:Cursor[]}
/** Experimental scheduler only. Relations and adjacency ordering belong to the frozen caller. */
export function deferredWalk(roots:SymbolFact[],patterns:readonly TraversalPattern[],budget:ExplorationBudget,beamWidth:number,
 access:{entity(id:string):SymbolFact|undefined;neighbors(id:string,direction:TraversalStep['direction']):readonly RelationFact[];compare(a:SymbolFact,b:SymbolFact):number},signal?:AbortSignal,observe?:(event:ProgressiveObservation)=>void){
 for(const value of [beamWidth,budget.maxVisitedNodes,budget.maxVisitedEdges,budget.maxExpandedStates])if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid deferred traversal bound');
 if(new Set(roots.map(r=>r.id)).size>budget.maxVisitedNodes)throw Error('Exploration budget is smaller than root set');
 const discoveries:PatternDiscovery[]=[],states=new Map<string,PatternDiscovery>(),nodes=new Set<string>(),lanes:Lane[]=patterns.filter(p=>p.steps.length).map(pattern=>({pattern,queue:[]}));
 let visitedEdges=0,expandedStates=0,stopReason='frontier_exhausted',stopped=false,depthReached=false,laneIndex=0,round=0,turns=0;
 let frontierEnqueued=0,frontierDeferred=0,frontierResumed=0,frontierExhausted=0,maxDeferredQueueSize=0,maxPatternQueueSize=0,duplicateStatesAvoided=0,peakDeferredQueueBytes=0;
 const cursors:Cursor[]=[],parents=new Set<string>(),scheduledPatterns=new Set<string>(),perPattern:Record<string,number>={},perDepth:Record<string,number>={};
 const queueBound=roots.length*lanes.length+budget.maxVisitedEdges;
 const identity=(d:PatternDiscovery,p:TraversalPattern)=>explanationStateId({entity:d.entity,rootEntityId:d.rootEntityId,patternId:p.id,stepIndex:d.depth,direction:(p.steps[d.depth]??p.steps.at(-1))!.direction});
 const emit=(decision:ProgressiveObservation['decision'],d:PatternDiscovery,p:TraversalPattern,c?:Cursor,edge?:RelationFact,neighborEntity?:SymbolFact)=>observe?.({decision,state:d,stepIndex:d.depth,direction:(p.steps[d.depth]??p.steps.at(-1))!.direction,inspectionOrdinal:visitedEdges,schedulerRound:round,...(c?{neighborOrdinal:c.nextNeighborIndex}:{}),edge,neighborEntity});
 const measure=()=>{const size=lanes.reduce((n,l)=>n+l.queue.length,0);if(size>queueBound)throw Error('Derived frontier bound exceeded');maxDeferredQueueSize=Math.max(maxDeferredQueueSize,size);maxPatternQueueSize=Math.max(maxPatternQueueSize,...lanes.map(l=>l.queue.length));peakDeferredQueueBytes=Math.max(peakDeferredQueueBytes,Buffer.byteLength(JSON.stringify(lanes.flatMap(l=>l.queue.map(c=>({stateId:c.stateId,patternId:l.pattern.id,stepIndex:c.discovery.depth,nextNeighborIndex:c.nextNeighborIndex,remainingNeighbors:c.edges.length-c.nextNeighborIndex}))))));};
 const enqueue=(lane:Lane,c:Cursor)=>{lane.queue.push(c);frontierDeferred++;emit('DEFERRED',c.discovery,lane.pattern,c);measure();};
 const admit=(entity:SymbolFact,rootEntityId:string,lane:Lane,depth:number,direction:string,via?:RelationFact,parentStateId?:number)=>{
  const d:PatternDiscovery={entity,rootEntityId,patternId:lane.pattern.id,depth,direction,...(via?{via}:{}),...(parentStateId===undefined?{}:{parentStateId}),stateId:discoveries.length,show:true},key=identity(d,lane.pattern);states.set(key,d);discoveries.push(d);nodes.add(entity.id);emit('REACHED',d,lane.pattern);
  if(depth>=lane.pattern.steps.length){depthReached=true;return;}
  const c:Cursor={discovery:d,stateId:key,edges:access.neighbors(entity.id,lane.pattern.steps[depth]!.direction),nextNeighborIndex:0,turns:0};cursors.push(c);frontierEnqueued++;
  if(c.edges.length)enqueue(lane,c);else{frontierExhausted++;emit('EXHAUSTED',d,lane.pattern,c);}
 };
 for(const root of [...new Map(roots.map(r=>[r.id,r])).values()].sort(access.compare))for(const lane of lanes)admit(root,root.id,lane,0,lane.pattern.steps[0]!.direction);
 while(!stopped&&lanes.some(l=>l.queue.length)){
  round++;
  for(let slot=0;slot<beamWidth&&!stopped;slot++){
   signal?.throwIfAborted();let lane:Lane|undefined;
   for(let i=0;i<lanes.length;i++){const next=lanes[laneIndex]!;laneIndex=(laneIndex+1)%lanes.length;if(next.queue.length){lane=next;break;}}
   if(!lane)break;const c=lane.queue[0]!,d=c.discovery,rule=lane.pattern.steps[d.depth]!;
   // A stopped cursor remains pending; no unperformed edge read consumes a slot.
   if(c.turns===0&&expandedStates>=budget.maxExpandedStates){stopReason='expanded_states';stopped=true;emit('BUDGET_STOP',d,lane.pattern,c);break;}
   if(visitedEdges>=budget.maxVisitedEdges){stopReason='visited_edges';stopped=true;emit('BUDGET_STOP',d,lane.pattern,c);break;}
   lane.queue.shift();frontierResumed++;emit('RESUMED',d,lane.pattern,c);turns++;parents.add(c.stateId);scheduledPatterns.add(lane.pattern.id);
   if(c.turns===0){expandedStates++;emit('EXPANDED',d,lane.pattern,c);}c.turns++;
   const edge=c.edges[c.nextNeighborIndex++]!;visitedEdges++;perPattern[lane.pattern.id]=(perPattern[lane.pattern.id]??0)+1;perDepth[d.depth]=(perDepth[d.depth]??0)+1;emit('INSPECTED',d,lane.pattern,c,edge);
   // Requeue this parent first, then its child. Both compete on the next lane turns.
   if(c.nextNeighborIndex<c.edges.length)enqueue(lane,c);else{frontierExhausted++;emit('EXHAUSTED',d,lane.pattern,c);}
   if(!rule.relations.includes(edge.relation)||!['resolved_scoped','resolved_import_alias'].includes(edge.resolution)){emit('SKIPPED_PATTERN_MISMATCH',d,lane.pattern,c,edge);continue;}
   const entity=access.entity(rule.direction==='upstream'?edge.fromId:edge.toId);if(!entity)continue;
   if(!nodes.has(entity.id)&&nodes.size>=budget.maxVisitedNodes){stopReason='visited_nodes';stopped=true;emit('BUDGET_STOP',d,lane.pattern,c,edge,entity);break;}
   const child={...d,entity,depth:d.depth+1},key=identity(child,lane.pattern);
   if(states.has(key)){duplicateStatesAvoided++;emit('SKIPPED_DUPLICATE_STATE',d,lane.pattern,c,edge,entity);continue;}
   admit(entity,d.rootEntityId,lane,d.depth+1,rule.direction,edge,d.stateId);
  }
 }
 if(!stopped&&depthReached)stopReason='depth_reached';
 const pending=lanes.flatMap(l=>l.queue.map(c=>({stateId:c.stateId,patternId:l.pattern.id,stepIndex:c.discovery.depth,nextNeighborIndex:c.nextNeighborIndex,remainingNeighbors:c.edges.length-c.nextNeighborIndex,starved:c.turns===0}))),queueBytes=Buffer.byteLength(JSON.stringify(pending));
 return {discoveries,visitedNodes:nodes.size,visitedEdges,expandedStates,frontierDropped:0,droppedFrontier:[],stopReason,coverageLimited:stopped,
  schedulerMetrics:{schedulerRounds:round,schedulerOperations:turns,frontierEnqueued,frontierDeferred,frontierResumed,frontierExhausted,pendingFrontiersAtStop:pending.length,pending,distinctParentsScheduled:parents.size,distinctPatternsScheduled:scheduledPatterns.size,perPatternEdgeInspections:perPattern,perDepthEdgeInspections:perDepth,maxDeferredQueueSize,maxPatternQueueSize,duplicateStatesAvoided,frontierStateCount:states.size,frontierCursorCount:cursors.length,deferredQueueBytes:queueBytes,peakDeferredQueueBytes,deferredQueueBytesDefinition:'Serialized cursor metadata proxy; adjacency arrays shared, never copied',derivedQueueCapacity:queueBound,starvedFrontierStates:pending.filter(p=>p.starved).length,permanentlyDropped:0}};
}
