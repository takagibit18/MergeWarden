import test from 'node:test';
import assert from 'node:assert/strict';
import {describeCandidates,selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
import {candidateUnits} from '../src/experiments/locagent/path-candidates.ts';
import {retainStructuralPaths,explanationStateId} from '../src/experiments/locagent/path-retention.ts';
const context={snapshotId:'s',generationId:'g',route:'STRUCTURAL_ESCALATION',changedPaths:['root.py'],visibleRanges:[{path:'leaf.py',startLine:1,endLine:2}]};
function fixture(){
 const states=[['root',0],['left',1],['right',1],['leaf',2]].map(([name,stepIndex])=>({entity:{id:name,snapshotId:'s',path:name+'.py',name,qualifiedName:name,kind:'function',startLine:1,endLine:9},rootEntityId:'root',patternId:'calls-out',stepIndex,direction:'downstream'}));
 const links=[[0,1],[0,2],[1,3],[2,3]].map(([a,b],i)=>({previousStateId:explanationStateId(states[a]),stateId:explanationStateId(states[b]),direction:'downstream',edge:{id:'edge'+i,snapshotId:'s',fromId:states[a].entity.id,toId:states[b].entity.id,relation:'CALLS',resolution:'resolved_scoped'}}));
 const graph=retainStructuralPaths({snapshotId:'s',generationId:'g',states,links});return {graph,units:candidateUnits(graph)};
}
test('candidate descriptions preserve frozen diamond paths and distinguish partial source visibility',()=>{
 const {graph,units}=fixture(),before=JSON.stringify({graph,units}),r=describeCandidates(units,graph,context),leaf=r.eligible.find(x=>x.terminalEntityId==='leaf');
 assert.equal(r.rejected.length,0);assert.equal(leaf.pathSupportCount,2);assert.equal(leaf.distinctPredecessorCount,2);assert.equal(leaf.alreadyVisible,false);assert.equal(leaf.buckets.depth,'multi_hop');assert.deepEqual(leaf.relationSequences,[['CALLS','CALLS'],['CALLS','CALLS']]);assert.equal(JSON.stringify({graph,units}),before);
 assert.deepEqual(r,describeCandidates([...units].reverse(),graph,context));
});

const candidate=(id,depth=1,options={})=>({terminalEntityId:id,terminalPath:id+'.py',sourceRange:{startLine:1,endLine:10},depth,pathSupportCount:1,alreadyVisible:false,changed:false,classification:'production',sameRootFile:false,patternIds:['calls-out'],retainedPaths:[{depth,directions:['downstream']}],relationSequences:[Array(depth).fill('CALLS')],...options});
test('one multi-hop cross-file terminal satisfies two obligations; independent lane gets remaining slot',()=>{
 const pool=[candidate('a'),candidate('z',2,{pathSupportCount:2}),candidate('b',2),candidate('other',1,{patternIds:['imports']})],r=selectCandidateSet(pool,context);
 assert.equal(r.selected[0].candidate.terminalEntityId,'z');assert.equal(r.selected[0].selectedBecause,'multi_hop_obligation');assert.equal(r.selected[1].selectedBecause,'pattern_diversity');assert.equal(r.selected.length,3);assert.equal(r.obligations.crossFile,true);
 for(let i=0;i<100;i++)assert.equal(JSON.stringify(r),JSON.stringify(selectCandidateSet([...pool].reverse(),context)));
});
test('visibility precedes support and depth order is ascending within multi-hop bucket',()=>{
 const pool=[candidate('a',3,{pathSupportCount:2,alreadyVisible:true}),candidate('b',3),candidate('c',2)],r=selectCandidateSet(pool,context);assert.equal(r.selected[0].candidate.terminalEntityId,'c');
});
test('route-specific direct caller and frozen import template outrank generic support',()=>{
 const caller=candidate('caller',1,{retainedPaths:[{depth:1,directions:['upstream']}]}),deep=candidate('deep',3,{pathSupportCount:2});assert.equal(selectCandidateSet([deep,caller],{...context,route:'CALLER_CHECK'}).selected[0].selectedBecause,'direct_caller');
 const a=candidate('a',1,{relationSequences:[['IMPORTS']]}),b=candidate('b',2,{relationSequences:[['IMPORTS','IMPORTS']],pathSupportCount:2});assert.deepEqual(selectCandidateSet([a,b],{...context,route:'IMPORT_CHECK'},['a','b']).selected.map(s=>s.candidate.terminalEntityId),['a','b']);
 const inherit=candidate('base',1,{relationSequences:[['INHERITS']]});assert.equal(selectCandidateSet([deep,inherit],{...context,route:'INHERITANCE_CHECK'}).selected[0].selectedBecause,'inheritance_terminal');
});
test('stable fill suppresses duplicate ranges but allows distinct same-file terminals',()=>{
 const a=candidate('a',2),duplicate=candidate('dup',2,{terminalPath:'a.py'}),b=candidate('b',1,{terminalPath:'a.py',sourceRange:{startLine:20,endLine:30}}),c=candidate('c');
 const r=selectCandidateSet([a,duplicate,b,c],context);assert.deepEqual(r.selected.map(s=>s.candidate.terminalEntityId),['a','c','b']);assert.ok(r.omitted.includes('dup'));
});
test('empty and shallow pools never manufacture a multi-hop candidate',()=>{
 assert.equal(selectCandidateSet([],context).selected.length,0);const r=selectCandidateSet([candidate('one')],context);assert.equal(r.selected.length,1);assert.ok(!r.selected.some(s=>s.selectedBecause==='multi_hop_obligation'));
});
test('candidate eligibility rejects foreign identities, malformed locations and unretained provenance',()=>{
 const {graph,units}=fixture();
 for(const mutate of [u=>u.generationId='foreign',u=>u.terminalEntity.endLine=NaN,u=>u.retainedPaths[0].edgeIds[0]='invented',u=>u.bestPath.depth=0]){
  const changed=structuredClone(units);mutate(changed[0]);const r=describeCandidates(changed,graph,context);assert.ok(r.rejected.length);assert.ok(!r.eligible.some(x=>x.terminalEntityId===changed[0].terminalEntity.id));
 }
 const bad=structuredClone(graph);for(const s of bad.states)for(const l of s.predecessorPaths)l.edge.resolution='candidate';assert.equal(describeCandidates(units,bad,context).eligible.length,0);
});
