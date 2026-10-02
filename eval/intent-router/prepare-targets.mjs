import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities} from '../candidate-dataset-context.mjs';
// This adapter copies an existing frozen field. It never infers a new target
// from model plans, rationale, the oracle, or source-window outcomes.
const out=resolve(process.argv[2]),history=resolve(process.argv[3]);
const predictions=await read(join(out,'phase-b/prediction-freeze.json'));assert.equal(predictions.allFirstAttemptsFinished,true);await checkIdentities(predictions.files);
const scoringFreeze=await read(join(out,'scoring-implementation-freeze.json'));await checkIdentities(scoringFreeze.files);
const oldFreeze=await read(join(history,'phase-b/private-freeze.json'));await checkIdentities(oldFreeze.inputs);
const source=join(history,'phase-b/private-material.json'),sourceIdentity=await identity(source);assert.ok(oldFreeze.inputs.some(i=>i.path===sourceIdentity.path&&i.sha256===sourceIdentity.sha256));
const material=await read(source),oldUniverse=await read(join(history,'universe.json')),universe=await read(join(out,'universe.json')),cases=[];
for(const c of universe.primary.filter(c=>c.group==='defect'&&c.status==='PUBLIC_ADMITTED')){
  const old=oldUniverse.plans.find(p=>p.caseId===c.caseId),record=material.find(r=>r.caseId===c.caseId);assert.equal(old.snapshotId,c.snapshotId);assert.equal(old.reviewedSha,c.reviewedSha);
  const targets=(record?.requiredUntouched??[]).filter(t=>typeof t.path==='string'&&Number.isSafeInteger(t.startLine)&&Number.isSafeInteger(t.endLine)&&t.startLine>=1&&t.endLine>=t.startLine).map(t=>({snapshotId:c.snapshotId,path:t.path,startLine:t.startLine,endLine:t.endLine,frozenSourceHash:t.contentSha256??null,role:t.role??null}));
  cases.push({alias:c.alias,caseId:c.caseId,snapshotId:c.snapshotId,status:targets.length?'TARGET_FROZEN':'PRIVATE_TARGET_INSUFFICIENT',targets,reason:targets.length?'Exact historical requiredUntouched ranges, bound to the same frozen case snapshot.':'Historical requiredUntouched has no complete necessary range.',sourceField:'requiredUntouched',sourceIdentity});
}
await save(join(out,'phase-c-private/necessary-targets.json'),{cases,sourceInputs:[sourceIdentity,await identity(join(history,'phase-b/private-freeze.json')),await identity(join(history,'universe.json'))],predictionFreeze:await identity(join(out,'phase-b/prediction-freeze.json')),targetPolicy:'Any original requiredUntouched interval may establish candidate reach; no source-window/fact scoring, target rewriting, or model-informed target choice.'});
await save(join(out,'phase-c-private/target-projection-freeze.json'),{implementation:await identity(import.meta.filename),output:await identity(join(out,'phase-c-private/necessary-targets.json')),source:sourceIdentity});
console.log(JSON.stringify({targetsFrozen:cases.length,insufficient:cases.filter(c=>c.status!=='TARGET_FROZEN').length}));
