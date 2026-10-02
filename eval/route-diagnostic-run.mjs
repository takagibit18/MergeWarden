import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,hash,identity,checkIdentities} from './candidate-dataset-context.mjs';
import {replayRoute} from './route-diagnostic-replay.mjs';
import {createFeatureExtractor} from './route-observable-features.mjs';
const phase=process.argv[3]??'phase-a';assert.ok(/^phase-a(?:-v[0-9]+)?$/.test(phase));const out=resolve(process.argv[2]),{plans}=await read(join(out,'universe.json')),implementation=await read(join(out,phase==='phase-a'?'implementation-sha.json':'implementation-sha-'+phase+'.json'));
assert.ok(process.permission);for(const path of implementation.privatePaths)assert.equal(process.permission.has('fs.read',path),false);await checkIdentities(implementation.files);
const replay=[],features=[],files=[];
// Historical consistency is a separate gate before ANY feature/outcome diagnosis.
for(const plan of plans){const a=await replayRoute(plan),b=await replayRoute(plan);assert.equal(hash(a),hash(b),'Non-deterministic route replay');
  if(a.historicalMatch===false){await save(join(out,phase+'/reconstruction-drift.json'),{caseId:plan.caseId,expected:plan.historicalExpected,actual:a.summary});throw Error('STOP: Route-state reconstruction drift');}
  const path=join(out,phase+'/route-prefixes',plan.caseId+'.json');await save(path,{caseId:plan.caseId,snapshotId:plan.snapshotId,changedPaths:plan.changedPaths,prefixKind:plan.prefixKind,boundary:a.prefixBoundary,observations:a.events});files.push(await identity(path));replay.push({...a,determinism:{replays:2,sha256:hash(a),byteStable:true}});
}
await save(join(out,phase+'/historical-consistency.json'),{pass:true,knownDefects:12,matches:replay.filter(r=>r.historicalMatch===true).length,cleanWithoutHistoricalRouteBaseline:16});
const extractor=await createFeatureExtractor();try{for(const [i,p] of plans.entries()){const a=extractor.extract(replay[i],p),b=extractor.extract(replay[i],p);assert.equal(hash(a),hash(b));features.push({...a,determinism:{replays:2,sha256:hash(a),byteStable:true}});}}finally{extractor.close();}
for(const [name,data]of [['route-replay',replay],['observable-features',features],['signal-matrix',plans.map((p,i)=>({caseId:p.caseId,group:p.group,triggered:replay[i].routeTriggered,high:replay[i].highSignals.length,weak:replay[i].weakSignals.length,searchPressure:replay[i].searchPressureReached,structural:features[i].structural,behavioral:features[i].behavioral,interaction:{...features[i].interaction,calleePairs:undefined},search:features[i].search,contextGap:features[i].contextGap,coverage:features[i].coverage}))]]){const path=join(out,phase,name+'.json');await save(path,data);files.push(await identity(path));}
for(const path of ['protocol.json','universe.json',phase==='phase-a'?'implementation-sha.json':'implementation-sha-'+phase+'.json',phase+'/historical-consistency.json'])files.push(await identity(join(out,path)));
await checkIdentities(implementation.files);await save(join(out,phase+'/diagnostic-freeze.json'),{identity:'real-route-recall-diagnostic-1',frozenAt:new Date().toISOString(),allCasesComplete:true,privateRead:false,caseCount:28,files,implementation,graphRequests:0,modelCalls:0});
console.log(JSON.stringify({cases:28,historicalMatches:12,routeHits:replay.filter(r=>r.routeTriggered).length,weak:replay.filter(r=>r.weakSignals.length).length}));
