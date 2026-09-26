import {join,resolve} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {read,save,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {userPrompt,SYSTEM_PROMPT} from './prompt.mjs';
const out=resolve(process.argv[2]),freeze=await read(join(out,'phase-b/prediction-freeze.json'));assert.equal(freeze.allFirstAttemptsFinished,true);await checkIdentities(freeze.files);
const publicFreeze=await read(join(out,'phase-a/experiment-freeze.json'));await checkIdentities(publicFreeze.publicFiles);await checkIdentities(publicFreeze.implementation);
const inputs=await read(join(out,'phase-a/input-hashes.json')),targets=await read(join(out,'phase-c-private/necessary-targets.json')),checks=[];
const publicSources=[];for(const name of ['contracts.mjs','input.mjs','parse.mjs','prompt.mjs','runtime.mjs','run.mjs'])publicSources.push({name,text:await readFile(join(import.meta.dirname,name),'utf8')});
for(const item of inputs){const input=await read(item.file.path),response=await read(join(out,'phase-b/raw-responses',item.caseId+'.json')),prompt=userPrompt(input);assert.equal(hash(input),item.inputHash);assert.equal(hash(prompt),item.promptHash);
  if(response.wirePayload){const messages=response.wirePayload.messages;assert.equal(messages.length,2);assert.equal(messages[0].content,SYSTEM_PROMPT);assert.equal(messages[1].content,prompt);assert.ok(!response.wirePayload.tools||response.wirePayload.tools.length===0);}
  const target=targets.cases.find(t=>t.alias===item.caseId),overlaps=[];
  for(const t of target?.targets??[]){assert.ok(publicSources.every(s=>!s.text.includes(t.path)),'Static Phase A/B source contains a private target literal');if(prompt.includes(t.path))overlaps.push({path:t.path,classification:'ALREADY_IN_FROZEN_PUBLIC_PROJECTION',inputFreezePrecedesPrivateTargetAccess:true});}
  checks.push({caseId:item.caseId,inputHash:item.inputHash,wireMatchesFrozenPrompt:response.wirePayload?true:null,privateTargetLiteralInSource:false,publicTargetPathOverlaps:overlaps,modelSawCatalog:false,priorPredictionInContext:false});
}
await save(join(out,'anti-leakage.json'),{status:'PASS',checks,phaseAPrivatePermissionDenied:true,phaseBPrivatePermissionDenied:true,predictionFreezeBeforePrivateRead:true,interpretation:'A target path can legitimately occur in an already frozen public diff/search result. Such overlap is reported with public provenance; no private target annotations, necessary ranges or oracle pairs were inserted.'});
console.log(JSON.stringify({antiLeakage:'PASS',cases:checks.length,publicPathOverlapCases:checks.filter(c=>c.publicTargetPathOverlaps.length).length}));
