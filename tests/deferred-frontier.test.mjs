import test from 'node:test';import assert from 'node:assert/strict';
import {deferredWalk} from '../src/experiments/locagent/deferred-frontier.ts';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {retainStructuralPaths} from '../src/experiments/locagent/path-retention.ts';
import {exactTelemetry} from '../eval/frontier-data.mjs';
const budget={maxVisitedNodes:30,maxVisitedEdges:200,maxExpandedStates:200};
function fixture(pairs){const symbols=[...new Set(pairs.flatMap(p=>p.slice(0,2)))].map(id=>({id,snapshotId:'s',name:id,path:id+'.py',qualifiedName:id,kind:'function',startLine:1,endLine:2})),edges=pairs.map(([fromId,toId,relation='CALLS'],i)=>({id:'e'+i,snapshotId:'s',fromId,toId,relation,resolution:'resolved_scoped'})),access={entity:id=>symbols.find(s=>s.id===id),compare:(a,b)=>a.id<b.id?-1:a.id>b.id?1:0,neighbors:(id,dir)=>edges.filter(e=>(dir==='upstream'?e.toId:e.fromId)===id).sort((a,b)=>{const x=dir==='upstream'?a.fromId:a.toId,y=dir==='upstream'?b.fromId:b.toId;return x<y?-1:x>y?1:a.id.localeCompare(b.id);})};return {symbols,edges,access,root:symbols.find(s=>s.id==='A')};}
function run(f,b=budget){const events=[],search=deferredWalk([f.root],STRUCTURAL_PATTERNS,b,4,f.access,undefined,e=>events.push(e));return {search,events};}
test('progressive parent turns reach grandchildren before exhausting high-fanout root siblings',()=>{
 const f=fixture([['A','B'],['A','C'],['A','D'],['A','E'],['A','F'],['B','G'],['C','H']]),{events,search}=run(f),calls=events.filter(e=>e.decision==='INSPECTED'&&e.state.patternId==='calls-out');
 const grand=calls.findIndex(e=>e.state.entity.id==='B'),lastRoot=calls.findLastIndex(e=>e.state.entity.id==='A');assert.ok(grand<lastRoot);assert.ok(search.discoveries.some(d=>d.entity.id==='H'));assert.equal(search.frontierDropped,0);assert.equal(search.schedulerMetrics.schedulerOperations,search.visitedEdges);assert.ok(search.schedulerMetrics.frontierResumed>0);
});
test('lanes get deterministic turns and mismatches consume the same finite edge budget',()=>{
 const f=fixture([['A','B'],['A','C','IMPORTS'],['D','A'],['A','E','INHERITS'],['F','A','INHERITS']]),{events,search}=run(f,{...budget,maxVisitedEdges:7}),calls=events.filter(e=>e.decision==='INSPECTED');assert.equal(calls.length,7);assert.deepEqual(calls.slice(0,5).map(e=>e.state.patternId),STRUCTURAL_PATTERNS.map(p=>p.id));assert.equal(search.stopReason,'visited_edges');assert.ok(search.schedulerMetrics.pendingFrontiersAtStop>0);assert.ok(events.some(e=>e.decision==='SKIPPED_PATTERN_MISMATCH'));
});
test('diamond expands shared state once while exact telemetry retains two parents',()=>{
 const f=fixture([['A','B'],['A','C'],['B','D'],['C','D'],['D','E']]),{events,search}=run(f),t=exactTelemetry(events,search),r=retainStructuralPaths({snapshotId:'s',generationId:'g',...t.input});
 assert.equal(events.filter(e=>e.decision==='EXPANDED'&&e.state.patternId==='calls-out'&&e.state.entity.id==='D'&&e.state.depth===2).length,1);assert.ok(search.schedulerMetrics.duplicateStatesAvoided>0);assert.equal(r.states.find(s=>s.patternId==='calls-out'&&s.entity.id==='D'&&s.stepIndex===2).paths.length,2);
});
test('cycles, node and state stops leave bounded pending cursors and respect pattern steps',()=>{
 const f=fixture([['A','B'],['B','C'],['C','A'],['B','D','IMPORTS']]);for(const b of [budget,{...budget,maxVisitedNodes:2},{...budget,maxExpandedStates:2}]){const {search}=run(f,b);assert.ok(search.visitedNodes<=b.maxVisitedNodes);assert.ok(search.expandedStates<=b.maxExpandedStates);assert.ok(search.visitedEdges<=b.maxVisitedEdges);assert.ok(search.schedulerMetrics.maxDeferredQueueSize<=search.schedulerMetrics.derivedQueueCapacity);assert.ok(search.discoveries.every(d=>d.depth<=STRUCTURAL_PATTERNS.find(p=>p.id===d.patternId).steps.length));assert.ok(!search.discoveries.some(d=>d.patternId==='calls-out'&&d.entity.id==='D'));}
});
test('stable neighbor construction and repeated selection are independent of input array construction',()=>{
 const f=fixture([['A','C'],['A','B'],['B','D'],['C','D']]),first=run(f);f.edges.reverse();f.symbols.reverse();for(let i=0;i<100;i++)assert.deepEqual(run(f),first);
});
