import test from 'node:test';import assert from 'node:assert/strict';
import {buildCandidateDocuments,rankCandidateRelevance,selectRelevance} from '../src/experiments/locagent/candidate-relevance.ts';
import {selectPathCoverage} from '../src/experiments/locagent/path-coverage.ts';
const entity=(id,name)=>({id,snapshotId:'s',name,qualifiedName:'package.'+name,path:'package/'+id+'.py'});
const root=entity('root','start');
const candidate=(id,name,edge=id)=>{const e=entity(id,name);return {snapshotId:'s',terminalEntity:e,terminalEntityId:id,terminalPath:e.path,sourceRange:{startLine:1,endLine:10},depth:1,pathSupportCount:1,alreadyVisible:false,changed:false,classification:'production',sameRootFile:false,patternIds:['out'],retainedPaths:[{edgeIds:[edge],stateIds:['root',id],entityIds:['root',id],directions:['downstream'],patternId:'out',depth:1}],relationSequences:[['CALLS']]};};
const context={route:'STRUCTURAL_ESCALATION'},lengths={out:1};
test('candidate document uses all frozen path entities without source text or duplicate field boosting',()=>{
 const c=candidate('c','fetch_records'),docs=buildCandidateDocuments([c],[root,c.terminalEntity]);assert.ok(docs[0].tokens.includes('start'));assert.ok(docs[0].tokens.includes('fetch'));assert.equal(docs[0].tokens.filter(t=>t==='fetch_records').length,1);assert.throws(()=>buildCandidateDocuments([c],[root]),/Missing/);
});
test('sparse relevance selects matching metadata with stable score ranks across input orders',()=>{
 const cs=[candidate('a','fetch_records'),candidate('b','compute_total'),candidate('c','store_records'),candidate('d','render_view')],es=[root,...cs.map(c=>c.terminalEntity)],run=xs=>rankCandidateRelevance(xs,es,'records',lengths),r=run(cs);
 assert.ok(r.rows[0].matchedTokens.includes('record'));assert.ok(r.rows[0].rawBm25>0);assert.equal(r.rows.at(-1).rawBm25,0);for(let i=0;i<100;i++)assert.deepEqual(run([...cs].reverse()),r);
});
test('all-zero relevance preserves exact frozen structural selection order',()=>{
 const cs=[candidate('c','collect'),candidate('b','build'),candidate('a','apply'),candidate('d','delete')],rank=rankCandidateRelevance(cs,[root,...cs.map(c=>c.terminalEntity)],'unrelated',lengths);
 const r=selectRelevance(cs,context,rank,lengths),old=selectPathCoverage(cs,context,lengths);assert.equal(r.relevanceFallback,true);assert.deepEqual(r.selected.map(s=>s.candidate),old.selected.map(s=>s.candidate));assert.ok(r.selected.every(s=>s.selectedBecause==='structural_fallback'));
});
