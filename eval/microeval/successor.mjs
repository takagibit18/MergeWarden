import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {cp,readFile,mkdir,copyFile} from 'node:fs/promises';
import {read,save,hash,identity,probe,targetInCatalog} from './common.mjs';
const previous=resolve(process.argv[2]),out=resolve(process.argv[3]);
assert.notEqual(previous,out);assert.equal((await readFile(join(out,'baseline-exit.txt'),'utf8')).trim(),'0');
const priorGate=await read(join(previous,'gate.json')),priorFreeze=await read(join(previous,'prediction-freeze.json'));
assert.equal(priorGate.providerRequests,0);assert.equal(priorFreeze.allFirstAttemptsFinished,true);
for(const f of priorFreeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
const config=await read(join(previous,'run-config.json')),manifest=await read(join(previous,'case-manifest.json')),targets=await read(join(previous,'private/targets.json'));
const state=join(out,'state');for(const dir of ['snapshots','blobs','graphs'])await cp(join(previous,'state',dir),join(state,dir),{recursive:true,errorOnExist:true,force:false});
for(const entry of config.cases){
 const input=await read(entry.path),c=input.case,t=targets.cases.find(t=>t.id===c.id),m=manifest.find(m=>m.id===c.id);
 assert.equal(hash(t),m.privateTargetHash);assert.equal(hash(input.prefix),m.publicPrefixHash);
 c.state=state;const execution=await probe(c,input.prefix);if(c.id!=='C1')assert(targetInCatalog(execution.pack,t.targets));
 await save(join(out,'admission',c.id+'.json'),execution);entry.path=join(out,'public',c.id+'.json');await save(entry.path,input);
 await mkdir(join(state,'runs',c.seedId),{recursive:true});await copyFile(join(previous,'state/runs',c.seedId,'run.json'),join(state,'runs',c.seedId,'run.json'));
}
const protocol=await read(join(previous,'protocol.json'));
Object.assign(protocol,{executionId:'post-startup-fix-1',predecessor:previous,predecessorStatus:priorGate.status,predecessorProviderRequests:0,authorization:'User explicitly reissued the Micro E2E request after the mechanical repair. New first live attempts; predecessor artifacts preserved.',baselineHead:'f307c52aef407b651ebec105850088791c868723',baselineTests:483,preflight:'Before live slots, execute both arms on all three exact immutable snapshots under the same filesystem isolation using a scripted HTTP provider. No real provider requests or semantic findings. Keep preflight sessions separate.',unchanged:'Case selection, public prefix, question, intent, model, sampling, tools, final contract, catalog ordering, previews, and traversal.'});
protocol.scoring.necessaryFact+=' Count only payloads with a successful provider HTTP response; locally prepared/failed outgoing requests alone do not establish receipt.';
await save(join(out,'case-manifest.json'),manifest);await save(join(out,'run-config.json'),config);await save(join(out,'protocol.json'),protocol);await save(join(out,'private/targets.json'),targets);
await save(join(out,'successor-lineage.json'),{previous,predecessorFreeze:await identity(join(previous,'prediction-freeze.json')),originalCaseManifest:await identity(join(previous,'case-manifest.json')),sameManifest:hash(manifest)===hash(await read(join(previous,'case-manifest.json'))),authorizedNewExecution:true,realModelRequestsSoFar:0});
console.log(JSON.stringify({executionId:protocol.executionId,cases:config.cases.map(c=>c.id),preservedPriorRequests:0}));
