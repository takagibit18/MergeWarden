import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
import {publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {createOAuthModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {resolveModelPolicy} from '../../integrations/pi/src/model-policy.ts';
import {SkillBank} from '../../src/skills/bank.ts';
const root=resolve(process.argv[2]),auth=resolve(process.argv[3]),repo=resolve(import.meta.dirname,'../..'),read=async p=>JSON.parse(await readFile(p,'utf8'));
const ex=await read(join(root,'execution/experiment.json')),gate=await read(join(root,'stage-a.json')),lock=await read(join(root,'corpus/corpus.lock.json'));
const out=join(root,'recovery');await mkdir(out,{recursive:true});
const checks=[];
for(const [kind,files] of [['engineering',gate.code],['experiment',ex.code],['corpus',lock.files]]){const mismatches=[];for(const f of files)if(sha256(await readFile(join(kind==='corpus'?join(root,'corpus'):repo,f.path)))!==f.sha256)mismatches.push(f.path);checks.push({kind,files:files.length,mismatches});}
const lockMatches=sha256(await readFile(join(root,'corpus/corpus.lock.json')))===ex.corpusLockSha256;
await writeJson(join(out,'integrity.json'),{checks,lockMatches,at:new Date().toISOString()});assert(checks.every(c=>!c.mismatches.length)&&lockMatches,'Frozen files drifted; stop');
for(const c of ex.cases)for(const arm of ['A','B','C'])assert.equal(sha256(await readFile(await publishedGraphPath(join(root,'execution',arm),c.snapshotId))),c.graphSha256);
const runtime=await createOAuthModelRuntime(ex.model.provider,auth),policy=resolveModelPolicy(runtime.getModel(ex.model.provider,ex.model.modelId),ex.inference).configuration;
const old=await read(join(root,'execution/A/runs/1f136317-1fa2-40bf-b71f-e8a09de08f40/run.json'));const {requestCount,lastRequestSha256,...oldPolicy}=old.runtimeConfiguration.inference;assert.deepEqual(policy,oldPolicy);
assert.equal((await new SkillBank(join(root,'execution/B')).skills()).length,0);
const history=[];for(const arm of ['A','B','C']){const runRoot=join(root,'execution',arm,'runs');for(const id of await readdir(runRoot))for(const file of await readdir(join(runRoot,id))){const p=join(runRoot,id,file);try{history.push({path:p,sha256:sha256(await readFile(p))});}catch(e){if(e.code!=='EISDIR')throw e;}}}
await writeJson(join(out,'historical-files.json'),history);
for(const path of ['summary','execution/stop.json','resume-plan.json','execution/B/skills/jobs'])await cp(join(root,path),join(out,'before',path),{recursive:true,errorOnExist:true,force:false});
await writeJson(join(out,'protocol.json'),{status:'PREFLIGHT_PASS',authPath:auth,accountIdentity:'same account confirmed by user; no independent historical fingerprint',quotaRecovery:'user confirmed; no ping',providerCalls:0,model:ex.model,policy,policySha256:sha256(JSON.stringify(policy)),experimentSha256:sha256(await readFile(join(root,'execution/experiment.json'))),order:['two never-started source A','completed-source B learning','freeze B','comments','clone B into C','feedback learning','freeze C','12 frozen-order pilot reviews'],sourceRemaining:['RG2-ec7b305c3e7e','RG2-48266c37abb7'],failedSourcePolicy:'ineligible_source; no retry',stopOnQuota:true,remaining:{review:14,learning:23,comment:6,adjudication:12},formalAuthorized:false,at:new Date().toISOString()});
console.log('PASS: frozen code/corpus/graphs/model policy; same OAuth path present; history archived; no model call.');
