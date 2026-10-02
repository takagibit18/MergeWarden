import test from 'node:test';import assert from 'node:assert/strict';
import {derivePathCoverage,pathCoverageMetrics,selectPathCoverage} from '../src/experiments/locagent/path-coverage.ts';
import {selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
const candidate=(id,paths,options={})=>({terminalEntityId:id,terminalPath:id+'.py',sourceRange:{startLine:1,endLine:10},depth:Math.max(...paths.map(p=>p.length)),pathSupportCount:paths.length,alreadyVisible:false,changed:false,classification:'production',sameRootFile:false,patternIds:['calls-out'],retainedPaths:paths.map(edges=>({edgeIds:edges,stateIds:['root',...edges.map(e=>'s'+e)],entityIds:['root',...edges.map(e=>'n'+e)],directions:edges.map(()=>'downstream'),patternId:'calls-out',depth:edges.length})),relationSequences:paths.map(p=>p.map(()=>'CALLS')),...options});
const lengths={'calls-out':3},context={snapshotId:'s',generationId:'g',route:'STRUCTURAL_ESCALATION',changedPaths:[],visibleRanges:[]};
test('coverage unions shared edges once and preserves independent root branch signatures',()=>{
 const c=candidate('z',[['a','b','d'],['a','c','d']]),before=JSON.stringify(c),d=derivePathCoverage(c,lengths);assert.deepEqual(d.pathEdgeSet,['a','b','c','d']);assert.equal(d.rootBranchSignatures.length,1);assert.equal(d.patternComplete,true);assert.deepEqual(d.remainingPatternSteps,[0,0]);assert.equal(JSON.stringify(c),before);
 const m=pathCoverageMetrics([d],[d]);assert.equal(m.edgeCoverageRatio,1);assert.equal(m.selectedCoveredEdges,4);
});
test('intermediate and unknown-pattern terminals remain described without inventing terminality',()=>{
 const c=candidate('mid',[['a','b']]);assert.equal(derivePathCoverage(c,lengths).patternComplete,false);const d=derivePathCoverage(c,{});assert.deepEqual(d.remainingPatternSteps,[null]);assert.deepEqual(d.unknownPatterns,['calls-out']);assert.equal(d.patternComplete,false);
});
test('pairwise Jaccard is a diagnostic over edge/state sets including disjoint and empty cases',()=>{
 const a=derivePathCoverage(candidate('a',[['a','b']]),lengths),b=derivePathCoverage(candidate('b',[['b','c']]),lengths),m=pathCoverageMetrics([a,b],[a,b]);assert.equal(m.averageEdgeOverlapJaccard,1/3);assert.equal(m.averageStateOverlapJaccard,0.5);assert.equal(pathCoverageMetrics([],[]).edgeCoverageRatio,0);
});
test('greedy fill values new edges over repeated shared prefixes and does not reserve a lane slot',()=>{
 const pool=[candidate('a',[['a','b','c'],['a','d','e']]),candidate('b',[['a','b','c']]),candidate('c',[['x','y']]),candidate('d',[['v']]),candidate('e',[['a']])],r=selectPathCoverage(pool,context,lengths);
 assert.deepEqual(r.selected.map(s=>s.candidate.terminalEntityId),['a','c','d']);assert.deepEqual(r.selected.map(s=>s.marginalEdgeCoverage),[5,2,1]);assert.equal(r.metrics.selectedCoveredEdges,8);assert.equal(r.selected[0].selectedBecause,'multi_hop_obligation:path_coverage');
});
test('terminality breaks equal gain without excluding intermediates or overpowering greater gain',()=>{
 const mid=candidate('mid',[['a','b'],['a','c']]),end=candidate('end',[['x','y','z']]),larger=candidate('larger',[['j','k'],['l','m']]);
 assert.equal(selectPathCoverage([mid,end],context,lengths).selected[0].candidate.terminalEntityId,'end');assert.equal(selectPathCoverage([mid,end,larger],context,lengths).selected[0].candidate.terminalEntityId,'larger');assert.ok(selectPathCoverage([mid],context,lengths).selected.some(s=>s.candidate.terminalEntityId==='mid'));
});
test('hard obligations may share a slot and duplicate exact ranges cannot consume a second slot',()=>{
 const a=candidate('a',[['a','b']]),dup=candidate('dup',[['q','r']],{terminalPath:'a.py'}),cross=candidate('cross',[['x']],{sameRootFile:false});
 const r=selectPathCoverage([a,dup,cross],context,lengths);assert.equal(r.selected.length,2);assert.equal(r.obligations.crossFile,true);assert.ok(r.omitted.includes('dup'));
 const root=candidate('root',[['a','b','c']],{sameRootFile:true}),two=selectPathCoverage([root,cross],context,lengths);assert.equal(two.selected[1].selectedBecause,'cross_file_obligation:path_coverage');
});
test('all route-specific selected candidates and reasons remain identical to frozen selector',()=>{
 for(const route of ['CALLER_CHECK','IMPORT_CHECK','INHERITANCE_CHECK']){
  const relation=route==='IMPORT_CHECK'?'IMPORTS':route==='INHERITANCE_CHECK'?'INHERITS':'CALLS',a=candidate('a',[['a']]),b=candidate('b',[['b']]);for(const c of [a,b]){c.relationSequences=[[relation]];c.retainedPaths[0].directions=['upstream'];}
  const ctx={...context,route},before=selectCandidateSet([a,b],ctx,['b','a']),after=selectPathCoverage([a,b],ctx,lengths,['b','a']);assert.deepEqual(after.selected.map(s=>({candidate:s.candidate,selectedBecause:s.selectedBecause})),before.selected);
 }
});
test('repeated original, reverse and permuted pools select byte-identical units, reasons and atoms',()=>{
 const pool=[candidate('c',[['x','y']]),candidate('b',[['a','c']]),candidate('a',[['a','b','c']]),candidate('d',[['m']])],expected=JSON.stringify(selectPathCoverage(pool,context,lengths));
 for(let i=0;i<100;i++)for(const p of [pool,[...pool].reverse(),[pool[2],pool[0],pool[3],pool[1]]])assert.equal(JSON.stringify(selectPathCoverage(p,context,lengths)),expected);
});
