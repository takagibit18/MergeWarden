import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {admission,scoreTargets,afterGenerationFreeze,summarize} from '../eval/candidate-dataset-score.mjs';
import {save,identity} from '../eval/candidate-dataset-context.mjs';
const target={path:'a.py',startLine:10,endLine:12};
const full={entityReached:true,pathRetained:true,targetEligible:true,candidateSelected:true};
const row={status:null,poolSize:4,realContext:true,routeTriggered:true,anchorResolved:true,determinism:{stable:true}};
test('private scorer cannot be opened before whole generation freeze or with mutated inputs',async t=>{
  const out=await mkdtemp(join(tmpdir(),'mw-phase-'));t.after(()=>rm(out,{recursive:true,force:true}));let read=false;
  const privateRead=()=>{read=true;return 'private';};await assert.rejects(afterGenerationFreeze(out,privateRead));assert.equal(read,false);
  const path=join(out,'input.json');await save(path,{public:true});const i=await identity(path);
  await save(join(out,'phase-a/generation-freeze.json'),{allActivatedCasesComplete:true,files:[i]});
  assert.equal((await afterGenerationFreeze(out,privateRead)).value,'private');
  read=false;await writeFile(path,'corrupt');await assert.rejects(afterGenerationFreeze(out,privateRead));assert.equal(read,false);
});
test('range scorer requires whole range and every target; hit/miss does not mutate inputs',()=>{
  const e={id:'entity',path:'a.py',startLine:8,endLine:15},trace={reachedEntities:[e],retained:{states:[{entity:e,paths:[{depth:1}]}]}},slate=[{candidateId:'C01',terminalEntity:e}];
  const before=JSON.stringify({trace,slate});const hit=scoreTargets([target],trace,slate,{selected:[{candidateId:'C01'}]});
  assert.equal(admission(row,hit).caseRole,'CONTROL_HIT');assert.equal(admission(row,scoreTargets([target],trace,slate,{selected:[]})).caseRole,'SEMANTIC_CHALLENGE_MISS');
  assert.equal(admission(row,scoreTargets([target,{...target,endLine:20}],trace,slate,{selected:[]})).reason,'TARGET_NOT_REACHED');assert.equal(JSON.stringify({trace,slate}),before);
});
test('dataset admission preserves early failures, duplicates, pool bounds and generation misses',()=>{
  for(const status of ['NO_REAL_CONTEXT','ROUTE_NOT_TRIGGERED','ANCHOR_FAILED','GRAPH_DEGRADED','DUPLICATE_UNDERLYING_CASE'])assert.equal(admission({...row,status},[full]).reason,status);
  assert.equal(admission({...row,poolSize:3},[full]).reason,'POOL_TOO_SMALL');assert.equal(admission({...row,poolSize:31},[full]).reason,'POOL_TOO_LARGE');
  assert.equal(admission(row,[{...full,targetEligible:false}]).reason,'TARGET_NOT_ELIGIBLE');assert.equal(admission(row,[{...full,pathRetained:false}]).reason,'TARGET_PATH_NOT_RETAINED');assert.equal(admission(row,[]).reason,'MISSING_PRIVATE_SCORER');
  assert.equal(admission({...row,determinism:{stable:false}},[full]).reason,'NONDETERMINISTIC_GENERATION');
  const r={...row,...admission(row,[full])},m=summarize([r,{...row,...admission({...row,status:'DUPLICATE_UNDERLYING_CASE'},[])}]);assert.equal(m.funnel.universeDefects,1);assert.equal(m.pass,false);
});
test('permission boundary denies private reads and phase A mutation in isolated processes',async t=>{
  const out=await mkdtemp(join(tmpdir(),'mw-permissions-'));t.after(()=>rm(out,{recursive:true,force:true}));const secret=join(out,'gold.json'),publicPath=join(out,'public.json');await save(secret,{target:'secret'});await save(publicPath,{candidate:'C01'});
  const a=spawnSync(process.execPath,['--permission','--allow-fs-read='+publicPath,'--input-type=module','-e',`import {readFileSync} from 'node:fs'; try {readFileSync(process.argv[1]);process.exit(1)} catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e}`,secret]);assert.equal(a.status,0);
  const b=spawnSync(process.execPath,['--permission','--allow-fs-read='+publicPath,'--input-type=module','-e',`import {writeFileSync} from 'node:fs';try {writeFileSync(process.argv[1],'corrupt');process.exit(1)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e}`,publicPath]);assert.equal(b.status,0);
});
