import {join,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {readGraphEntities} from '../../src/graph/sqlite-store.ts';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {replayPrefix,completePages,buildUnits,projectInput} from './input.mjs';
import {SYSTEM_PROMPT,INPUT_TEMPLATE,userPrompt} from './prompt.mjs';
import {EXPERIMENT,GATE,MODEL_CONFIG,OUTPUT_SCHEMA,legalPlans} from './contracts.mjs';
const out=resolve(process.argv[2]),phase=join(out,'phase-a'),freeze=await read(join(out,'public-preparation-freeze.json'));
assert.ok(process.permission);for(const denied of freeze.denied)assert.equal(process.permission.has('fs.read',denied),false);
const rows=[],inputs=[],artifacts=[];
for(const c of freeze.cases){
  assert.equal(hash(await readFile(c.prefixPath)),c.prefixHash,'Historical prefix hash mismatch');const prefix=await read(c.prefixPath);
  const a=await replayPrefix(prefix),b=await replayPrefix(prefix);assert.equal(hash(a),hash(b),'STOP — MECHANICAL NONDETERMINISM');
  let status=a.triggered||hash(a.summary)!==hash(c.expectedSummary)?'RECONSTRUCTION_DRIFT':'PUBLIC_ADMITTED',units=[],details=null;
  const pages=completePages(prefix);if(status==='PUBLIC_ADMITTED'&&(!pages.length||pages.some(p=>!p.complete)))status='PUBLIC_INCOMPLETE_DIFF';
  if(status==='PUBLIC_ADMITTED'&&!c.graphPath)status='PUBLIC_GRAPH_UNAVAILABLE';
  if(status==='PUBLIC_ADMITTED'){
    assert.equal(hash(await readFile(c.graphPath)),c.graphIdentity.sha256);assert.equal(hash(await readFile(c.snapshotPath)),c.snapshotIdentity.sha256);
    const db=new DatabaseSync(c.graphPath,{readOnly:true});try{const meta=db.prepare('SELECT * FROM graph_snapshots WHERE snapshot_id=?').get(c.snapshotId);assert.equal(meta.generation_id,c.generationId);
      const symbols=readGraphEntities(db,c.snapshotId);details=buildUnits(prefix,symbols);assert.equal(hash(details),hash(buildUnits(prefix,symbols)),'STOP — MECHANICAL NONDETERMINISM');units=details.units.filter(u=>u.resolution==='resolved'&&u.entity);
    }finally{db.close();}
    if(!units.length)status='PUBLIC_NO_RESOLVED_CHANGE_UNIT';
  }
  const mapped=units.map((u,i)=>({...u,hostChangeUnitId:u.changeUnitId,changeUnitId:'CU'+String(i+1).padStart(2,'0')})),plans=legalPlans(mapped);
  const prefixDest=join(phase,'prefixes',c.alias+'.json');await save(prefixDest,prefix);artifacts.push(await identity(prefixDest));
  const unitsDest=join(phase,'change-units',c.alias+'.json');await save(unitsDest,{caseId:c.alias,snapshotId:c.snapshotId,generationId:c.generationId,units:mapped,details,legalPlans:plans});artifacts.push(await identity(unitsDest));
  let inputHash=null,promptHash=null;
  if(status==='PUBLIC_ADMITTED'){
    const input=projectInput(c.alias,prefix,a,units);assert.equal(hash(input),hash(projectInput(c.alias,prefix,b,units)));const prompt=userPrompt(input);assert.equal(prompt,userPrompt(structuredClone(input)));assert.ok(!prompt.includes(c.caseId));
    const path=join(phase,'semantic-inputs',c.alias+'.json');await save(path,input);const f=await identity(path);artifacts.push(f);inputHash=hash(input);promptHash=hash(prompt);inputs.push({caseId:c.alias,inputHash,promptHash,file:f});
  }
  rows.push({...c,deterministicRouteOutcome:a.triggered?'ROUTE':'NO_ROUTE',changeUnitHash:hash(mapped),status,changeUnits:units.length,completeDiffPaths:pages.filter(p=>p.complete).map(p=>p.path),inputHash,promptHash,deterministic:true,legalPlanCount:plans.plans.length,oraclePlansOmitted:plans.oraclePlansOmitted});
  console.log(JSON.stringify({caseId:c.alias,status,changeUnits:units.length}));
}
const counts=Object.fromEntries(['defect','clean'].map(group=>[group,{total:rows.filter(r=>r.group===group).length,admitted:rows.filter(r=>r.group===group&&r.status==='PUBLIC_ADMITTED').length,excluded:rows.filter(r=>r.group===group&&r.status!=='PUBLIC_ADMITTED').length}]));
const passed=counts.defect.admitted>=GATE.publicDefects&&counts.clean.admitted>=GATE.publicClean;
for(const [name,value] of [['universe',{identity:EXPERIMENT,primary:rows,fastPath:freeze.fastPath,duplicates:freeze.duplicates}],['public-admission',{identity:EXPERIMENT,status:passed?'PASS':'INSUFFICIENT_PUBLIC_CASES',counts,rows:rows.map(r=>({caseId:r.caseId,alias:r.alias,group:r.group,status:r.status,changeUnits:r.changeUnits})),modelCalls:0,privateAccess:false}],['case-order',{identity:EXPERIMENT,method:'ascending SHA256(experimentIdentity + originalCaseId)',order:rows.filter(r=>r.status==='PUBLIC_ADMITTED').map(r=>r.alias)}],['input-hashes',inputs],['model-config',MODEL_CONFIG],['schema',OUTPUT_SCHEMA]]){const p=join(phase,name+'.json');await save(p,value);artifacts.push(await identity(p));}
await writeFile(join(phase,'prompt.txt'),SYSTEM_PROMPT+'\n\n'+INPUT_TEMPLATE+'\n',{flag:'wx'});artifacts.push(await identity(join(phase,'prompt.txt')));await save(join(phase,'prompt-sha.json'),{systemPrompt:hash(SYSTEM_PROMPT),inputTemplate:hash(INPUT_TEMPLATE),schema:hash(OUTPUT_SCHEMA)});artifacts.push(await identity(join(phase,'prompt-sha.json')));
await save(join(phase,'generation-freeze.json'),{identity:EXPERIMENT,files:artifacts,modelCalls:0,privateAccess:false,graphTraversals:0,replays:2});console.log(JSON.stringify({publicGate:passed?'PASS':'STOP',counts}));
