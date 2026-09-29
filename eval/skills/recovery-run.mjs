// Isolated live review process; launch through launch.mjs.
import assert from 'node:assert/strict';
import {readFile,mkdir,open,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SkillBank,digest} from '../../src/skills/bank.ts';
import {ReviewEngine} from '../../src/engine/review.ts';
import {readRun,readReport} from '../../src/engine/reports.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {createOAuthModelRuntime,createPiRuntime} from '../../integrations/pi/src/runtime.ts';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
const dir=resolve(process.argv[2]),auth=resolve(process.argv[3]),phase=process.argv[4],read=async p=>JSON.parse(await readFile(p,'utf8'));
const ex=await read(join(dir,'experiment.json')),repo=resolve(import.meta.dirname,'../..');
assert(process.permission);assert.equal(process.permission.has('fs.read',join(dir,'../corpus/private/gold.jsonl')),false);
for(const f of ex.code)assert.equal(sha256(await readFile(join(repo,f.path))),f.sha256,'Code drift: '+f.path);
assert(['source','pilot'].includes(phase));
if(phase==='pilot')assert.equal((await read(join(dir,'learning-frozen.json'))).status,'FROZEN');
if(process.argv.includes('--check-only')){for(const c of ex.cases)for(const arm of ['A','B','C']){assert.equal(sha256(await readFile(await publishedGraphPath(join(dir,arm),c.snapshotId))),c.graphSha256);}await writeJson(join(dir,'preflight.json'),{status:'PASS',privateGoldDenied:true,cases:ex.cases.length,providerCalls:0});console.log('PASS: code, snapshot graph identities and private-label denial');process.exit(0);}
const allPlan=phase==='source'?ex.cases.filter(c=>c.split==='source').map(c=>({c,arm:'A'})):ex.cases.filter(c=>c.split==='pilot').flatMap((c,i)=>ex.pilotOrder.slice(i*3,i*3+3).map(arm=>({c,arm})));
const plan=allPlan.filter(p=>p.c.caseId===process.argv[5]&&p.arm===(process.argv[6]??'A'));assert.equal(plan.length,1);
const out=join(dir,'reviews');await mkdir(out,{recursive:true});
const modelRuntime=await createOAuthModelRuntime(ex.model.provider,auth);
let faults=0,recordQuota=false;
async function checkBank(arm){if(arm==='A')return;const f=await read(join(dir,arm+'-frozen.json')),b=new SkillBank(join(dir,arm));assert.equal((await b.current()).id,f.bankSnapshotId);assert.equal(digest(await b.skills()),f.catalogSha256);}

for(const {c,arm}of plan){const name=c.caseId+'-'+arm,path=join(out,name+'.json');
 let handle;try{handle=await open(path,'wx');}catch(e){if(e.code==='EEXIST')continue;throw e;}
 const count=(await readdir(out)).filter(n=>n.endsWith('.json')).length;assert(count+ex.reviewCallsPrior<=ex.reviewCallsMax,'Review allowance exceeded');
 await handle.writeFile(JSON.stringify({caseId:c.caseId,arm,phase,status:'started',startedAt:new Date().toISOString()}));await handle.close();
 const started=performance.now(),state=join(dir,arm);console.log(JSON.stringify({event:'started',caseId:c.caseId,arm}));
 try{await checkBank(arm);const binding=phase==='pilot'&&arm!=='A'?(await read(join(dir,'pilot-bindings.json'))).bindings.find(b=>b.caseId===c.caseId&&b.arm===arm):null;if(phase==='pilot'&&arm!=='A')assert(binding);assert.equal(sha256(await readFile(await publishedGraphPath(state,c.snapshotId))),c.graphSha256);const result=await new ReviewEngine(options=>createPiRuntime(options,modelRuntime,{extensions:[],firstAttemptOnly:true,preserveRouting:true})).run({repositoryPath:c.repositoryPath,stateDir:state,rerunId:binding?.seedId??c.seedId,model:ex.model,inference:ex.inference,timeoutMs:ex.timeoutMs,maxToolCalls:ex.maxToolCalls,skills:arm==='A'?'off':'replay',learn:'off',skillRepositoryKey:c.skillRepositoryKey,evaluation:{...ex.evaluation,contextCwd:join(dir,'context')}});
 assert.equal(result.kind,'report');assert.equal(result.report.snapshot.id,c.snapshotId);const manifest=await readRun(state,result.runId);await readReport(state,result.runId);const store=await SnapshotStore.load(state,c.snapshotId);for(const f of result.report.findings)for(const ev of f.evidence)assert.equal((await store.read(ev)).actualSha256,ev.contentSha256);
 await checkBank(arm);const record={caseId:c.caseId,arm,phase,status:result.report.status,runId:result.runId,elapsedMs:performance.now()-started,manifest,report:result.report};await writeJson(path,record);const session=await readFile(join(state,'runs',result.runId,'session.jsonl'),'utf8');recordQuota=session.includes('The usage limit has been reached');if(recordQuota)await writeJson(join(dir,'recovery-stop.json'),{reason:'provider_quota_still_blocked',caseId:c.caseId,runId:result.runId,at:new Date().toISOString()});console.log(JSON.stringify({event:'finished',caseId:c.caseId,arm,status:record.status,findings:record.report.findings.length}));if(record.status!=='completed')faults++;
 }catch(e){await writeJson(path,{caseId:c.caseId,arm,phase,status:'execution_error',error:e.message,elapsedMs:performance.now()-started});faults++;}
 if(recordQuota||faults>=1){console.log('Stopped after first fault; no retry.');break;}
}
