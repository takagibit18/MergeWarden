import test from 'node:test';import assert from 'node:assert/strict';
import {initialSeeds,rankMatches,textComparator,lexicalSeeds} from '../eval/route-utility-text.mjs';
import {graphComparator} from '../eval/route-utility-graph.mjs';
import {createHash} from 'node:crypto';
import {adjudicate,boundaryGate,exploratoryScore,containsFact} from '../eval/route-utility-rubric.mjs';
const prefix={snapshotId:'s',changedPaths:['pkg/a.py'],observations:[{ordinal:1,toolName:'read_diff',input:{},result:{status:'ok',path:'pkg/a.py',offset:0,lines:['@@ -1,2 +1,2 @@','+def changed(value):','+    return helper(value)']}},{ordinal:2,toolName:'search_text',input:{query:'prior'},result:{items:[]}}]};
test('utility text seeds use legal history and visible syntax, not strings/comments',()=>{assert.deepEqual(initialSeeds(prefix).map(x=>x.query),['prior','changed','helper']);assert.equal(lexicalSeeds('# secret_target()\nx="hidden_target()"','p.py',{}).length,0);});
test('utility partial diff docstrings cannot hide a later visible declaration',()=>{const s=lexicalSeeds('    old documentation\n    """\n    return x\ndef combine(a,b):\n    """new documentation"""\n    return a+b','p.py',{tool:'read_diff'});assert(s.some(s=>s.query==='combine'&&s.kind==='definition'));});
test('utility text result policy prefers production untouched exact matches',()=>{const hits=[{path:'pkg/tests/test_a.py',line:1,text:'helper()'},{path:'pkg/a.py',line:1,text:'helper()'},{path:'pkg/b.py',line:5,text:'helper()'}];assert.equal(rankMatches(hits,'helper',['pkg/a.py'])[0].path,'pkg/b.py');});
test('utility comparator bounds calls, source windows and deterministic follow-up',async()=>{let calls=0;const store={search:async(rev,q)=>{calls++;return {items:[{path:'pkg/b.py',line:calls*100,text:q+'()'}],truncated:false,coverage:{}};},source:async(rev,path,start,end)=>({path,startLine:start,endLine:end,text:'def next_helper():\n pass',contentSha256:'synthetic'})};const a=await textComparator(prefix,store);assert.equal(a.budgetUsed.searchCalls,3);assert.equal(a.sourceReads.length,3);assert(a.sourceReads.every(s=>s.endLine-s.startLine===79));calls=0;assert.deepEqual(a,await textComparator(prefix,store));});
test('utility comparator never includes partial source page beyond packet bound',async()=>{const store={search:async()=>({items:[{path:'pkg/b.py',line:1,text:'prior'}],coverage:{},truncated:false}),source:async()=>({path:'pkg/b.py',startLine:1,endLine:80,text:'x'.repeat(25000)})};const a=await textComparator(prefix,store);assert.equal(a.stopReason,'context_budget');assert.equal(a.sourceReads.length,1);assert.equal(a.packet.sources.length,0);assert(a.budgetUsed.contextBytes<=24576);});
test('utility graph preserves exact-anchor failure and only reads frozen selected candidates',async()=>{
 const symbols=['a','b'].map(id=>({id,snapshotId:'s',path:'pkg/'+id+'.py',name:id,qualifiedName:'pkg.'+id,kind:'function',startLine:1,endLine:4,startColumn:0,endColumn:0}));
 const data={snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations:[{id:'e',snapshotId:'s',fromId:'a',toId:'b',relation:'CALLS',resolution:'resolved_scoped',sourcePath:'pkg/a.py',sourceLine:2,sourceEndLine:2,siteId:'site',resolverVersion:'v4'}],sources:{},warnings:[],coverage:{eligibleFiles:2,indexedFiles:2}};
 const p={snapshotId:'s',changedPaths:['pkg/a.py'],observations:[{toolName:'read_source',toolCallId:'c',result:{snapshotId:'s',revision:'head',status:'ok',path:'pkg/a.py',startLine:2,endLine:2,text:'b()'}}]};
 const store={source:async(revision,path,startLine,endLine)=>({snapshotId:'s',revision,status:'ok',path,startLine,endLine,text:'pass',contentSha256:createHash('sha256').update('pass').digest('hex')})};
 const a=await graphComparator({caseId:'synthetic',snapshotId:'s',generationId:'g'},p,store,data);assert.equal(a.error,null);assert.equal(a.anchorStatus,'resolved');assert.deepEqual(a.sourcePack.sources.map(s=>s.path),['pkg/b.py']);assert.equal(a.budgetUsed.graphOps,2);assert.equal(a.counterfactualGraph,true);assert.deepEqual(a,await graphComparator({caseId:'synthetic',snapshotId:'s',generationId:'g'},p,store,data));
 const missing=await graphComparator({caseId:'synthetic',snapshotId:'s',generationId:'g'},{...p,observations:[]},store,data);assert.equal(missing.anchorStatus,'anchor_missing');assert.equal(missing.sourceReads.length,0);
});
test('utility rubric distinguishes discovery, delivery, text sufficiency and unknown evidence',()=>{
 assert.equal(adjudicate({decisionRelevant:true,graphOpportunity:true,graphDelivered:false,textRelevant:false}).label,'UNCERTAIN');
 assert.equal(adjudicate({decisionRelevant:true,graphDelivered:true,textRelevant:true}).label,'TEXT_FIRST');
 assert.equal(adjudicate({decisionRelevant:true,graphDelivered:true,textRelevant:false}).label,'GRAPH_ESCALATE');
 assert.equal(adjudicate({decisionRelevant:null}).label,'UNCERTAIN');
 assert.equal(adjudicate({decisionRelevant:true,toolMismatch:true}).label,'NO_ESCALATION');
 assert.equal(containsFact([{path:'a',startLine:1,endLine:80}],{path:'a',startLine:81,endLine:82}),false);
});
test('utility boundary and exploratory score do not rescue failures with uncertainty',()=>{
 assert.equal(boundaryGate([{label:'GRAPH_ESCALATE',confidence:'MEDIUM'},...Array(5).fill({label:'TEXT_FIRST',confidence:'MEDIUM'})]).pass,false);
 const r=exploratoryScore([{caseId:'a',label:'UNCERTAIN',confidence:'LOW'},{caseId:'b',label:'TEXT_FIRST',confidence:'MEDIUM'},{caseId:'c',label:'NO_ESCALATION',confidence:'MEDIUM'}],[{caseId:'a',decision:'ESCALATE'},{caseId:'b',decision:'UNCERTAIN'},{caseId:'c',decision:'TIMEOUT'}]);
 assert.equal(r.matrix.TN,0);assert.equal(r.matrix.FP,0);assert.equal(r.matrix.NEGATIVE_UNCERTAIN,1);assert.equal(r.matrix.FORMAT_OR_TRANSPORT_FAILURE,1);assert.equal(r.rows[0].result,'EXCLUDED_UNCERTAIN_LABEL');
});
