import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCase,opaqueSlate} from '../eval/candidate-dataset-generate.mjs';
import {hash} from '../eval/candidate-dataset-context.mjs';
const plan={caseId:'derived-test',sourceCaseId:'test',snapshotId:'s',generationId:'g',changedPaths:['app.py'],prefixKind:'test'};
const protocol={identity:'test-experiment',runtimeCommit:'frozen',selector:{version:'candidate-set'},retrievalImplementationSHA:'frozen'};
const entity=(id,path,name,kind='function')=>({id,path,name,qualifiedName:name,kind,snapshotId:'s',startLine:1,endLine:3,startColumn:0,endColumn:0});
const graph=()=>({snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols:[entity('root','app.py','work'),...Array.from({length:5},(_,i)=>entity('c'+i,'c'+i+'.py','caller'+i))],relations:Array.from({length:5},(_,i)=>({id:'edge'+i,snapshotId:'s',fromId:'c'+i,toId:'root',relation:'CALLS',resolution:'resolved_scoped',sourcePath:'c'+i+'.py',sourceLine:2,sourceEndLine:2,siteId:'site'+i,resolverVersion:'v4'})),sources:{},coverage:{eligibleFiles:6,indexedFiles:6},warnings:[]});
const observation=lines=>({toolName:'read_diff',toolCallId:'diff1',input:{path:'app.py'},result:{snapshotId:'s',path:'app.py',status:'ok',offset:0,totalLines:lines.length,lines},isError:false,provenance:{kind:'test'}});
test('dataset uses actual route and exact dispatch anchor; complete pool is independent of three slots',async()=>{
  let graphs=0;
  const obs=async function*(){yield observation(['@@ -1,2 +1,2 @@','-def work(a):','+def work(a, b):','     return a']);throw Error('Future source must not be read');};
  const result=await generateCase(plan,protocol,obs,async()=>{graphs++;return graph();});
  assert.equal(result.error,null);assert.equal(result.routeTriggered,true);assert.equal(result.anchorResolved,true);assert.equal(graphs,1);
  assert.equal(result.poolSize,5);assert.equal(result.baseline.selected.length,3);assert.equal(result.diagnostics.graphBackendRequests,2);
  assert.equal(result.diagnostics.deliverySourceReads,0);assert.equal(result.input.investigation.anchors[0].name,'work');
  assert.equal(result.candidateChoiceInputHash,(await generateCase(plan,protocol,obs,async()=>graph())).candidateChoiceInputHash);
  assert.equal(result.diagnostics.inspectionTrace.filter(t=>t.decision==='INSPECTED').length,result.diagnostics.edgeInspections);
});
test('no route never calls Graph; missing diff is not semantic context',async()=>{
  const load=()=>{throw Error('Graph should not execute');};
  const result=await generateCase(plan,protocol,async function*(){yield observation(['@@ -1,2 +1,2 @@',' def work(a):','-    return a','+    return a + 1']);},load);
  assert.equal(result.status,'ROUTE_NOT_TRIGGERED');
  assert.equal((await generateCase(plan,protocol,async function*(){},load)).status,'NO_REAL_CONTEXT');
});
test('opaque order and CandidateChoiceInput hashes do not depend on input pool order',()=>{
  const pool=Array.from({length:8},(_,i)=>({terminalEntityId:'e'+i,path:'x'+i}));
  const a=opaqueSlate(pool,'exp','case'),b=opaqueSlate([...pool].reverse(),'exp','case');
  assert.deepEqual(a,b);assert.equal(hash({candidateSlots:3,slate:a}),hash({candidateSlots:3,slate:b}));
  assert.deepEqual(a.map(x=>x.candidateId),['C01','C02','C03','C04','C05','C06','C07','C08']);
});
