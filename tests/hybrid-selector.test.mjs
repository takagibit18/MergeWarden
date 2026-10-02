import test from 'node:test';import assert from 'node:assert/strict';
import {selectHybrid,edgeJaccard} from '../src/experiments/locagent/hybrid-selector.ts';
import {rankCandidateRelevance} from '../src/experiments/locagent/candidate-relevance.ts';
import {selectPathCoverage} from '../src/experiments/locagent/path-coverage.ts';
const c=(id,edges)=>({snapshotId:'s',terminalEntity:{id,snapshotId:'s',name:'process',qualifiedName:'m.process',path:id+'.py'},terminalEntityId:id,terminalPath:id+'.py',sourceRange:{startLine:1,endLine:4},depth:edges.length,pathSupportCount:1,alreadyVisible:false,changed:false,classification:'production',sameRootFile:false,patternIds:['out'],retainedPaths:[{edgeIds:edges,stateIds:['root',...edges],entityIds:['root',id],directions:edges.map(()=> 'downstream'),patternId:'out',depth:edges.length}],relationSequences:[edges.map(()=> 'CALLS')]});
const lengths={out:3},context={route:'STRUCTURAL_ESCALATION'};
const ranking=cs=>({relevanceFallback:false,rows:cs.map((candidate,i)=>({candidate,coverage:{pathEdgeSet:candidate.retainedPaths[0].edgeIds,patternComplete:true},rawBm25:10-i*0.1,normalizedRelevance:1-i*0.01,rank:i+1}))});
test('hybrid first slot follows relevance and later slot trades near-duplicate paths for diversity',()=>{
 const cs=[c('a',['e','f']),c('b',['e','f']),c('c',['g','h']),c('d',['i','j'])],r=selectHybrid(cs,context,ranking(cs),lengths);
 assert.deepEqual(r.selected.map(s=>s.candidate.terminalEntityId),['a','c','d']);assert.equal(r.selected[0].selectedBecause,'highest_relevance');assert.equal(r.selected[1].mmrScore,0.75*0.98+0.25);assert.equal(edgeJaccard(['e','e','f'],['e','g']),1/3);
});
test('hybrid relevance remains stronger than structural gain and has no depth obligation',()=>{
 const cs=[c('a',['e']),c('b',['e','f','g']),c('c',['x'])],r=ranking(cs);r.rows[1].rawBm25=1;r.rows[1].normalizedRelevance=0.1;r.rows[2].rawBm25=9;r.rows[2].normalizedRelevance=0.9;
 const result=selectHybrid(cs,context,r,lengths);assert.equal(result.selected[0].candidate.depth,1);assert.equal(result.selected[1].candidate.terminalEntityId,'c');
});
test('hybrid route delegation and zero-score fallback retain frozen choices and reasons',()=>{
 const cs=[c('a',['e']),c('b',['f']),c('c',['g'])],entities=[{id:'root',snapshotId:'s',name:'start',qualifiedName:'m.start',path:'m.py'},...cs.map(c=>c.terminalEntity)];
 for(const route of ['STRUCTURAL_ESCALATION','CALLER_CHECK','IMPORT_CHECK','INHERITANCE_CHECK']){
  const ctx={route},r=rankCandidateRelevance(cs,entities,'absent',lengths),order=['c','b','a'],got=selectHybrid(cs,ctx,r,lengths,order),old=selectPathCoverage(cs,ctx,lengths,order);
  assert.deepEqual(got.selected.map(s=>s.candidate),old.selected.map(s=>s.candidate));if(route!=='STRUCTURAL_ESCALATION')assert.deepEqual(got.selected.map(s=>s.selectedBecause),old.selected.map(s=>s.selectedBecause));
 }
});
