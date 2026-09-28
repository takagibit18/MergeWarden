import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {executionOptions} from './oracle.mjs';
import {executePrediction} from './execute.mjs';
const out=resolve(process.argv[2]);assert.ok(process.permission);for(const p of (await read(join(out,'prediction-execution-policy.json'))).denied)assert.equal(process.permission.has('fs.read',p),false);
await checkIdentities((await read(join(out,'phase-b/prediction-freeze.json'))).files);await checkIdentities((await read(join(out,'phase-a/generation-freeze.json'))).files);
const universe=await read(join(out,'universe.json')),predictions=await read(join(out,'phase-b/parsed-predictions.json')),files=[];
for(const c of universe.primary.filter(c=>c.status==='PUBLIC_ADMITTED')){
  const pred=predictions.find(p=>p.caseId===c.alias);assert(pred);let execution={plans:[],union:[],metrics:{episodes:0,structuralOps:0,sourceReads:0,edgeInspections:0,visitedNodes:0,expandedStates:0,catalogItems:0,catalogBytes:0,packageBytes:0}};
  if(pred.status==='OK'){const options=await executionOptions(out,c);execution=await executePrediction(options,pred.prediction);const repeat=await executePrediction(options,pred.prediction);assert.equal(hash(execution),hash(repeat),'STOP — MECHANICAL NONDETERMINISM');}
  const path=join(out,'phase-d/predicted-execution',c.alias+'.json');await save(path,execution);files.push(await identity(path));console.log(JSON.stringify({caseId:c.alias,status:pred.status,executedPlans:execution.plans.length}));
}
await save(join(out,'phase-d/execution-freeze.json'),{files,replays:2,privateTargetAccess:false,oracleAccess:false,modelCalls:0});
