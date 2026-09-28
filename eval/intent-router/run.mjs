import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {SemanticIntentRuntime} from './runtime.mjs';
import {userPrompt} from './prompt.mjs';
const out=resolve(process.argv[2]),phase=join(out,'phase-b'),freeze=await read(join(out,'phase-a/experiment-freeze.json'));
assert.ok(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);
await checkIdentities(freeze.publicFiles);await checkIdentities(freeze.implementation);
await save(join(phase,'started.json'),{identity:freeze.identity,startedAt:new Date().toISOString(),firstAttemptOnly:true});
const config=await read(join(out,'phase-a/model-config.json')),order=await read(join(out,'phase-a/case-order.json')),inputs=await read(join(out,'phase-a/input-hashes.json'));
const runtime=await SemanticIntentRuntime.create(config),predictions=[],usage=[],latency=[],files=[];
for(const alias of order.order){const i=inputs.find(i=>i.caseId===alias);assert(i);const input=await read(i.file.path);assert.equal(hash(input),i.inputHash);assert.equal(hash(userPrompt(input)),i.promptHash);
  await save(join(phase,'attempts',alias+'.json'),{caseId:alias,attempt:1,startedAt:new Date().toISOString(),inputHash:i.inputHash});
  const result=await runtime.predict(input);const path=join(phase,'raw-responses',alias+'.json');await save(path,result);files.push(await identity(path));
  predictions.push({caseId:alias,...result.parsed});usage.push({caseId:alias,usage:result.usage,unavailable:result.usageUnavailable,requests:result.requests,httpStatus:result.httpStatus});latency.push({caseId:alias,latencyMs:result.latencyMs});
  console.log(JSON.stringify({caseId:alias,status:result.parsed.status,requests:result.requests,latencyMs:result.latencyMs,tokens:result.usage?.totalTokens??null}));
}
for(const [name,data] of [['parsed-predictions',predictions],['usage',usage],['latency',latency],['model-config',config]]){const path=join(phase,name+'.json');await save(path,data);files.push(await identity(path));}
await checkIdentities(freeze.publicFiles);await checkIdentities(freeze.implementation);
await save(join(phase,'prediction-freeze.json'),{identity:freeze.identity,files,caseCount:predictions.length,allFirstAttemptsFinished:true,privateAccess:false,modelConfig:config});
console.log(JSON.stringify({predictionFreeze:true,cases:predictions.length,providerFailures:predictions.filter(p=>p.status==='PROVIDER_FAILURE').length,formatFailures:predictions.filter(p=>p.status==='FORMAT_FAILURE').length}));
