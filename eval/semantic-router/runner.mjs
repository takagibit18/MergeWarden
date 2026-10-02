import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities} from '../candidate-dataset-context.mjs';
import {SemanticRouteRuntime} from './runtime.mjs';
import {sha} from './input.mjs';
import {userPrompt} from './prompt.mjs';
const out=resolve(process.argv[2]),mode=process.argv[3]??'primary';assert.ok(['primary','secondary'].includes(mode));
assert.ok(process.permission);assert.equal(process.permission.has('fs.read',join(out,'dataset-manifest.json')),false);
const freeze=await read(join(out,'experiment-freeze.json'));await checkIdentities(freeze.publicFiles);await checkIdentities(freeze.implementation);
const {order}=await read(join(out,'case-order.json')),hashes=await read(join(out,'input-hashes.json')),config=await read(join(out,'model-config.json'));
if(mode==='secondary'){const gate=await read(join(out,'gate.json'));assert.equal(gate.primaryGate,'PASS');await checkIdentities((await read(join(out,'prediction-freeze.json'))).files);}
const directory=join(out,mode==='primary'?'primary':'secondary');
await save(join(directory,'started.json'),{at:new Date().toISOString(),mode,experimentFreeze:await identity(join(out,'experiment-freeze.json')),attemptPolicy:'exclusive marker forbids rerun; no retry'});
const runtime=await SemanticRouteRuntime.create(config),predictions=[],files=[];
for(const round of(mode==='primary'?[1]:[2,3]))for(const alias of order){
  const input=await read(join(out,'inputs',alias+'.json')),expected=hashes.find(h=>h.caseId===alias);assert.equal(sha(input),expected.semanticRouteInputHash);assert.equal(sha(userPrompt(input)),expected.userPromptHash);
  const result=await runtime.decide(input),path=join(directory,'raw-responses',`${alias}-run${round}.json`);await save(path,{...result,round,semanticRouteInputHash:expected.semanticRouteInputHash,userPromptHash:expected.userPromptHash});files.push(await identity(path));
  predictions.push({caseId:alias,round,parsed:result.parsed,rawResponse:path,usage:result.usage,latencyMs:result.latencyMs,requests:result.requests,httpStatus:result.httpStatus});
  console.log(JSON.stringify({caseId:alias,round,recorded:true,status:result.parsed.status}));
}
for(const [name,value] of [['parsed-decisions',predictions],['usage',predictions.map(p=>({caseId:p.caseId,round:p.round,...p.usage,usageUnavailable:p.usage===null,provider:config.provider,modelId:config.modelId}))],['latency',predictions.map(p=>({caseId:p.caseId,round:p.round,latencyMs:p.latencyMs}))]]){const path=join(directory,name+'.json');await save(path,value);files.push(await identity(path));}
await checkIdentities(freeze.publicFiles);await checkIdentities(freeze.implementation);
await save(join(directory,'prediction-freeze.json'),{experiment:freeze.experiment,mode,frozenAt:new Date().toISOString(),caseCount:order.length,attempts:predictions.length,files,experimentFreeze:await identity(join(out,'experiment-freeze.json')),modelConfigHash:sha(config),privateRead:false,realRequests:predictions.reduce((n,p)=>n+p.requests,0)});
console.log(JSON.stringify({predictionFrozen:true,mode,attempts:predictions.length}));
