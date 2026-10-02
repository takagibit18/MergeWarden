import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {read,save,identity,hash,checkIdentities} from './candidate-dataset-context.mjs';
import {graphData} from './frontier-data.mjs';import {textComparator} from './route-utility-text.mjs';import {graphComparator} from './route-utility-graph.mjs';
const out=resolve(process.argv[2]),phaseName=process.argv[4]??'phase-a';assert(/^phase-a(?:-v\d+)?$/.test(phaseName));const phase=join(out,phaseName),implementationName=process.argv[3]??'implementation-freeze.json';assert(/^implementation-freeze(?:-\d+)?\.json$/.test(implementationName));const implementation=await read(join(out,implementationName));
assert(process.permission);for(const p of implementation.denied)assert.equal(process.permission.has('fs.read',p),false,'Private data accessible');assert.equal(process.permission.has('child'),false);
await checkIdentities(implementation.files);const inputFreeze=await read(join(phase,'input-freeze.json'));await checkIdentities([...inputFreeze.files,inputFreeze.protocol]);
const {plans}=await read(join(phase,'plans.json')),files=[],rows=[];
for(const p of plans){
 const prefix=await read(p.inputPath);assert.equal((await identity(p.inputPath)).sha256,p.inputSha256);
 const store=await SnapshotStore.load(p.state,p.snapshotId),start=performance.now(),data=await graphData(p),graphLoadMs=performance.now()-start;
 const repeat=[];for(let i=0;i<2;i++){let now=performance.now();const t=await textComparator(prefix,store),textMs=performance.now()-now;now=performance.now();const g=await graphComparator(p,prefix,store,data);repeat.push({t,g,textMs,graphMs:performance.now()-now});}
 assert.equal(hash(repeat[0].t),hash(repeat[1].t),'Text nondeterminism');assert.equal(hash(repeat[0].g),hash(repeat[1].g),'Graph nondeterminism');
 for(const [arm,value]of [['text-comparator',repeat[0].t],['graph-comparator',repeat[0].g]]){const dest=join(phase,arm,p.caseId+'.json');await save(dest,value);files.push(await identity(dest));}
 rows.push({caseId:p.caseId,alias:p.alias,text:repeat[0].t.budgetUsed,graph:repeat[0].g.budgetUsed,anchorStatus:repeat[0].g.anchorStatus,graphError:repeat[0].g.error,determinism:{replays:2,textHashes:repeat.map(r=>hash(r.t)),graphHashes:repeat.map(r=>hash(r.g)),stable:true},latency:{graphLoadMs,textMs:repeat.map(r=>r.textMs),graphMs:repeat.map(r=>r.graphMs)},latencyNote:'Wall latency excluded from deterministic comparison; cold read versus warmed filesystem differ.'});
 console.log(JSON.stringify({alias:p.alias,t:repeat[0].t.queries.map(q=>q.query),g:repeat[0].g.anchorStatus,reads:[repeat[0].t.sourceReads.length,repeat[0].g.sourceReads.length],reached:repeat[0].g.reachedEntities.length}));
}
await save(join(phase,'cost-proxy.json'),rows);files.push(await identity(join(phase,'cost-proxy.json')));
await checkIdentities(implementation.files);await checkIdentities(inputFreeze.files);
files.push(...inputFreeze.files,await identity(join(phase,'plans.json')),await identity(join(phase,'input-freeze.json')),inputFreeze.protocol,await identity(join(out,implementationName)));
await save(join(phase,'counterfactual-freeze.json'),{identity:'graph-vs-text-route-utility-1',frozenAt:new Date().toISOString(),allCasesComplete:true,caseCount:plans.length,files,implementation,privateScoringRead:false,modelCalls:0});
