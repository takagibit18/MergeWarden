import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,hash,identity,checkIdentities} from './candidate-dataset-context.mjs';

export async function afterGenerationFreeze(out,readPrivate) {
  const freeze=await read(join(out,'phase-a/generation-freeze.json'));
  assert.equal(freeze.allActivatedCasesComplete,true);
  await checkIdentities(freeze.files);
  const value=await readPrivate();
  await checkIdentities(freeze.files);
  return {freeze,value};
}
export function scoreTargets(targets,trace,slate,baseline) {
  const matches=(entity,t)=>entity.path===t.path&&entity.startLine<=t.startLine&&entity.endLine>=t.endLine&&(!t.entityId||entity.id===t.entityId);
  const selected=new Set(baseline.selected.map(s=>s.candidateId));
  return targets.map(t=>{
    const reached=trace.reachedEntities.filter(e=>matches(e,t));
    const retained=trace.retained?.states.filter(s=>s.paths.some(p=>p.depth>0)&&matches(s.entity,t))??[];
    const eligible=slate.filter(c=>matches(c.terminalEntity,t));
    return {...t,reachedEntityIds:reached.map(e=>e.id),retainedEntityIds:[...new Set(retained.map(s=>s.entity.id))],eligibleCandidateIds:eligible.map(c=>c.candidateId),entityReached:reached.length>0,pathRetained:retained.length>0,targetEligible:eligible.length>0,candidateSelected:eligible.some(c=>selected.has(c.candidateId))};
  });
}
export function admission(row,targets) {
  const reached=targets.length>0&&targets.every(t=>t.entityReached),retained=reached&&targets.every(t=>t.pathRetained),eligible=retained&&targets.every(t=>t.targetEligible);
  let reason=row.status;
  if(!reason)reason=!targets.length?'MISSING_PRIVATE_SCORER':!reached?'TARGET_NOT_REACHED':!retained?'TARGET_PATH_NOT_RETAINED':!eligible?'TARGET_NOT_ELIGIBLE':row.poolSize<4?'POOL_TOO_SMALL':row.poolSize>30?'POOL_TOO_LARGE':!row.determinism?.stable?'NONDETERMINISTIC_GENERATION':null;
  const baselineHit=eligible?targets.every(t=>t.candidateSelected):null;
  return {reason,valid:reason===null,targetReached:reached,targetPathRetained:retained,targetInPool:eligible,baselineHit,caseRole:reason===null?(baselineHit?'CONTROL_HIT':'SEMANTIC_CHALLENGE_MISS'):null};
}
export function summarize(rows) {
  const unique=rows.filter(r=>!['DUPLICATE_UNDERLYING_CASE','PHASE_2_NOT_ACTIVATED'].includes(r.reason));
  let current=unique;
  const funnel={universeDefects:unique.length};
  for(const [name,predicate]of [['realContextAvailable',r=>r.realContext],['routeTriggered',r=>r.routeTriggered],['anchorResolved',r=>r.anchorResolved],['targetReached',r=>r.targetReached],['pathRetained',r=>r.targetPathRetained],['targetEligible',r=>r.targetInPool],['poolSizeValid',r=>r.poolSize>=4&&r.poolSize<=30],['validCandidateChoice',r=>r.valid]]){current=current.filter(predicate);funnel[name]=current.length;}
  const primary=unique.filter(r=>r.valid),hits=primary.filter(r=>r.baselineHit),misses=primary.filter(r=>!r.baselineHit),inPool=unique.filter(r=>r.targetInPool);
  const pass=primary.length>=4&&hits.length>=1&&misses.length>=2;
  const recommended=primary.length>=6&&hits.length>=2&&misses.length>=2;
  return {funnel,valid:primary.length,hits:hits.length,misses:misses.length,targetInPool:inPool.length,targetInPoolRate:unique.length?inPool.length/unique.length:null,deterministicMissRate:inPool.length?inPool.filter(r=>!r.baselineHit).length/inPool.length:null,pass,recommended,status:recommended?'READY FOR STRONG-LLM CANDIDATE CHOICE MICRO-EVAL':pass?'MINIMUM DATASET READY':primary.length<4?'INSUFFICIENT VALID FULL-CONTEXT CASES':'INSUFFICIENT SEMANTIC CHALLENGE CASES',exclusions:Object.fromEntries([...new Set(unique.map(r=>r.reason).filter(Boolean))].sort().map(reason=>[reason,unique.filter(r=>r.reason===reason).length]))};
}

export async function runScoring(out,goldPath,complexPath) {
  if(process.permission)assert.equal(process.permission.has('fs.write',join(out,'phase-a')),false,'Scorer may not write Phase A');
  const {freeze,value}=await afterGenerationFreeze(out,async()=>({
    gold:(await readFile(goldPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse),complex:await read(complexPath)
  }));
  const generation=await read(join(out,'phase-a/case-generation.json')),{plans}=await read(join(out,'universe.json')),protocol=await read(join(out,'protocol.json'));
  const scorerIdentity={version:'source-range-containment-1',generationFreezeSha256:hash(freeze),sources:[await identity(goldPath),await identity(complexPath),await identity(import.meta.filename)],rangeRule:'Every historical contextEvidence range must be wholly contained by a reached / retained / eligible terminal. Complex exception uses every historical paths[].end exact entity and range. File entities may satisfy source-location targets only when the frozen pool actually contains that file entity. No scoring source reads.',allRequiredTargets:true};
  await save(join(out,'phase-b/scorer-identity.json'),scorerIdentity);
  const rows=[];
  for(const row of generation.rows){
    const plan=plans.find(p=>p.caseId===row.caseId);
    let targets=[];
    if(!['DUPLICATE_UNDERLYING_CASE','PHASE_2_NOT_ACTIVATED'].includes(row.status)) {
      const golden=value.gold.find(g=>g.id===plan.sourceCaseId),legacy=value.complex.find(g=>g.id===plan.sourceCaseId);
      const locations=golden?.contextEvidence?.map(({path,startLine,endLine,contentSha256})=>({path,startLine,endLine,contentSha256}))??legacy?.paths?.map(p=>({entityId:p.end.id,path:p.end.path,startLine:p.end.startLine,endLine:p.end.endLine}))??[];
      const trace=await read(join(out,'phase-a/raw-traces',row.caseId+'.json')),slate=await read(join(out,'phase-a/candidate-pools',row.caseId+'.json')),baseline=await read(join(out,'phase-a/baseline-selections',row.caseId+'.json'));
      targets=scoreTargets(locations,trace,slate,baseline);
      const score=admission(row,targets);
      rows.push({...row,...score,targets,repository:plan.repository,baseSha:plan.baseSha,reviewedSha:plan.reviewedSha,snapshotId:plan.snapshotId,graphGenerationId:plan.generationId,reviewContextPath:join(out,'phase-a/review-contexts',row.caseId+'.json'),candidateChoiceInputPath:join(out,'phase-a/candidate-choice-inputs',row.caseId+'.json'),candidatePoolPath:join(out,'phase-a/candidate-pools',row.caseId+'.json'),candidatePoolSize:row.poolSize,baselineSelectorIdentity:protocol.selector,baselineSelectedIds:baseline.selected.map(s=>s.candidateId),scorerIdentityHash:hash(scorerIdentity)});
    }else rows.push({...row,...admission(row,[]),targets});
  }
  const metrics=summarize(rows),phase1=summarize(rows.filter(r=>r.phase===1)),primary=rows.filter(r=>r.valid);
  await save(join(out,'phase-b/target-in-pool.json'),rows);
  await save(join(out,'phase-b/baseline-hit-miss.json'),rows.filter(r=>r.targetInPool).map(r=>({caseId:r.caseId,baselineHit:r.baselineHit,valid:r.valid,caseRole:r.caseRole,selected:r.baselineSelectedIds})));
  await save(join(out,'phase-b/stratification.json'),{...metrics,phase1});
  for(const [name,value]of [['primary-cases',primary],['control-hits',primary.filter(r=>r.baselineHit)],['challenge-misses',primary.filter(r=>!r.baselineHit)],['excluded-cases',rows.filter(r=>!r.valid)]])await save(join(out,'dataset',name+'.json'),value);
  await save(join(out,'dataset/dataset-manifest.json'),{identity:protocol.identity,status:metrics.status,admittedForModelExperiment:metrics.pass,generationFreeze:await identity(join(out,'phase-a/generation-freeze.json')),scorerIdentity,phase1Metrics:phase1,metrics,cases:primary});
  await checkIdentities(freeze.files);
  await save(join(out,'phase-b/integrity.json'),{phaseAUnchanged:true,filesChecked:freeze.files.length,scorerCannotWritePhaseA:process.permission?!process.permission.has('fs.write',join(out,'phase-a')):false});
  console.log(JSON.stringify({phase1,overall:metrics},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await runScoring(resolve(process.argv[2]),resolve(process.argv[3]),resolve(process.argv[4]));
