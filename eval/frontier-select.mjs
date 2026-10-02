import {readFile,writeFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import assert from 'node:assert/strict';
import {hash,read} from './frontier-data.mjs';
import {retainStructuralPaths} from '../src/experiments/locagent/path-retention.ts';
import {candidateUnits} from '../src/experiments/locagent/path-candidates.ts';
import {describeCandidates,selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
const out=resolve(process.argv[2]),arm=process.argv[3],dir=join(out,arm==='A'?'arm-a-traces':'arm-b-traces'),protocol=await read(join(out,'protocol.json')),ids=await read(join(out,'frozen-inputs.json')),freeze=await read(join(dir,'exploration-freeze.json'));
for(const f of freeze.artifacts)assert.equal(hash(await readFile(join(dir,f.name))),f.sha256);
const identity=ids.find(i=>i.path.replaceAll('\\','/').endsWith('/candidate-selection-20260925/candidate-units.json')),before=await readFile(identity.path);assert.equal(hash(before),identity.sha256);const contexts=JSON.parse(before);
const selectionIdentity=ids.find(i=>i.path.replaceAll('\\','/').endsWith('/candidate-selection-20260925/selection-results.json')),old=await read(selectionIdentity.path),rows=[];
for(const plan of protocol.cases){const r=await read(join(dir,plan.id+'.json')),context=contexts.find(c=>c.id===plan.id).context,order=old.find(c=>c.id===plan.id).armB.selected.map(c=>c.candidate.terminalEntityId);let first;const hashes=[];
 for(let i=0;i<100;i++){const retained=retainStructuralPaths(r.input),units=candidateUnits(retained),pool=describeCandidates(units,retained,context);assert.equal(pool.rejected.length,0);const selection=selectCandidateSet(pool.eligible,context,order),result={retained,units,pool,selection};hashes.push(hash(JSON.stringify(result)));first??=result;}
 assert.equal(new Set(hashes).size,1);rows.push({id:plan.id,...first,context,determinism:{repeats:100,byteStable:true,sha256:hashes[0]}});
}
await writeFile(join(dir,'candidate-replay.json'),JSON.stringify(rows,null,2)+'\n',{flag:'wx'});await writeFile(join(dir,'prediction-freeze.json'),JSON.stringify({frozenAt:new Date().toISOString(),explorationFreeze:freeze,candidateReplaySha256:hash(await readFile(join(dir,'candidate-replay.json'))),auditRead:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({arm,cases:rows.length,stable:rows.every(r=>r.determinism.byteStable)}));
