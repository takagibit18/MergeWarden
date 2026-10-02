import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {describeCandidates,selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
import {selectPathCandidates} from '../src/experiments/locagent/path-candidates.ts';
const out=resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8')),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const protocol=await read(join(out,'protocol.json')),identities=await read(join(out,'frozen-inputs.json'));
const input=async suffix=>{const i=identities.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)&&i.role==='frozen online input');assert.ok(i,'Unapproved input');const b=await readFile(i.path);assert.equal(hash(b),i.sha256);return JSON.parse(b);};
const old=await input('/candidate-selection.json'),paths=await input('/path-retention.json');
const units=[],results=[],reasons=[],metrics=[],performanceRows=[];
for(const plan of protocol.cases){
 const prior=old.find(x=>x.id===plan.id),retained=paths.find(x=>x.id===plan.id).retained;
 const roots=retained.states.filter(s=>s.stepIndex===0),context={snapshotId:plan.snapshotId,generationId:plan.generationId,route:plan.request.template,changedPaths:plan.request.changedPaths,visibleRanges:plan.actions?plan.actions.filter(a=>a.name==='read_source').map(a=>({path:a.args.path,startLine:a.args.startLine,endLine:a.args.endLine})):roots.slice(0,1).map(s=>({path:s.entity.path,startLine:s.entity.startLine,endLine:s.entity.startLine}))};
 const pool=describeCandidates(prior.candidateUnits,retained,context);assert.equal(pool.rejected.length,0,'Shared eligible pool changed');assert.equal(pool.eligible.length,prior.candidateUnits.length);
 const armA=selectPathCandidates(prior.candidateUnits,prior.context);for(const k of ['selected','omitted','diversity','deepestAvailable','deepSlotReserved'])assert.deepEqual(armA[k],prior[k],'Arm A drift');
 const templateOrder=armA.selected.map(u=>u.terminalEntity.id),run=()=>selectCandidateSet(pool.eligible,context,templateOrder),selection=run(),serialized=JSON.stringify(selection),times=[],digests=new Set(),heap=[],rss=[];
 for(let i=0;i<100;i++){digests.add(hash(JSON.stringify(run())));assert.equal(JSON.stringify(selectCandidateSet([...pool.eligible].reverse(),context,templateOrder)),serialized);}
 for(let i=0;i<1000;i++){const start=performance.now(),r=run();times.push(performance.now()-start);assert.equal(JSON.stringify(r),serialized);if(i%10===0){global.gc?.();heap.push(process.memoryUsage().heapUsed);rss.push(process.memoryUsage().rss);}}
 const sorted=times.sort((a,b)=>a-b),longest=xs=>{let n=0,max=0;for(let i=1;i<xs.length;i++){n=xs[i]>xs[i-1]?n+1:0;max=Math.max(max,n);}return max;};
 const selectionBytes=Buffer.byteLength(serialized),temporarySelectionBytes=Buffer.byteLength(JSON.stringify(pool.eligible))+selectionBytes;
 const chosen=selection.selected.map(s=>s.candidate),count=(xs,p)=>xs.filter(p).length;
 units.push({id:plan.id,context,...pool,sharedPoolSha256:hash(JSON.stringify(prior.candidateUnits)),retainedDagSha256:hash(JSON.stringify(retained))});
 results.push({id:plan.id,armA,armB:selection});reasons.push({id:plan.id,selected:selection.selected.map(s=>({terminalEntityId:s.candidate.terminalEntityId,selectedBecause:s.selectedBecause,obligations:selection.obligations}))});
 metrics.push({id:plan.id,eligibleCandidates:pool.eligible.length,selectedCandidates:chosen.length,candidateSlots:3,multiHopEligible:count(pool.eligible,u=>u.depth>=2),multiHopSelected:count(chosen,u=>u.depth>=2),crossFileEligible:count(pool.eligible,u=>!u.sameRootFile),crossFileSelected:count(chosen,u=>!u.sameRootFile),...selection.obligations,pathSupportDistribution:Object.fromEntries([1,2].map(n=>[n,count(pool.eligible,u=>u.pathSupportCount===n)])),determinism:{repeats:100,byteIdentical:digests.size===1,reversedInputIdentical:true,sha256:hash(serialized)},maxParentsPerState:retained.metrics.maxParentsPerState,graphBackendRequests:0,sourceReads:0,temporarySelectionBytes});
 performanceRows.push({id:plan.id,repeats:1000,latencyMs:{p50:sorted[499],p95:sorted[949],max:sorted[999]},eligibleSize:pool.eligible.length,selectedSize:chosen.length,selectionBytes,temporarySelectionBytes,memory:{postGcHeap:heap,rss,longestMonotonicHeapIncrease:longest(heap),longestMonotonicRssIncrease:longest(rss),heapGrowthBytes:heap.at(-1)-heap[0]},pass:sorted[949]<=protocol.performance.p95LimitMs && longest(heap)<protocol.performance.maxConsecutivePostGcHeapGrowth && heap.at(-1)-heap[0]<protocol.performance.maxPostGcHeapGrowthBytes});
 console.log(JSON.stringify({id:plan.id,eligible:pool.eligible.length,selected:chosen.map(u=>u.terminalEntity.qualifiedName),stable:digests.size===1}));
}
const code=await readFile(new URL('../src/experiments/locagent/candidate-set.ts',import.meta.url),'utf8');
assert.ok(!/merge_attrs|xarray|sklearn|sympy|private\/|audit\.json|Golden|node:fs|search_entity|traverse_graph/i.test(code));
// Under Node's permission model, prove the scorer-only input is inaccessible in this process.
const denied=identities.find(i=>i.role==='post-freeze scorer only');assert.ok(process.permission,'Run with Node --permission and an explicit read allowlist');assert.equal(process.permission.has('fs.read',denied.path),false);
await save('candidate-units.json',units);await save('selection-results.json',results);await save('selection-reasons.json',reasons);await save('selection-metrics.json',metrics);await save('performance.json',performanceRows);
await save('audit-isolation.json',{staticCheck:true,nodePermissionModel:true,scorerInputReadable:false,graphBackendRequests:0,realModelCalls:0,selectorSha256:hash(code)});
const names=['protocol.json','candidate-units.json','selection-results.json','selection-reasons.json','selection-metrics.json','performance.json','audit-isolation.json'];
await save('prediction-freeze.json',{frozenAt:new Date().toISOString(),auditParsed:false,artifacts:await Promise.all(names.map(async name=>({name,sha256:hash(await readFile(join(out,name)))})))});
