import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './open-label.mjs';
import {sha256} from '../../src/infrastructure/files.ts';
import {ReviewBudget} from '../../src/engine/budget.ts';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const read=async path=>JSON.parse(await readFile(path,'utf8'));
export const model={provider:'openai-codex',modelId:'gpt-5.6-luna'};
export const inference={thinkingLevel:'max',maxOutputTokens:32768};
export const referenceRun=(runId,snapshotId)=>({schemaVersion:1,runId,snapshotId,referenceOnly:true});
export const evaluationFor=(arm,experiment)=>experiment?.changeAware ? (arm==='A'?{tools:'text-only',graphMode:'prepared_only',routing:'pi_structural_v1',routingTextOnly:true,declarationAware:true}:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2',declarationAware:true}) : arm==='A'?{tools:'text-only',graphMode:'prepared_only'}:arm==='B'?{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}:(()=>{throw Error('Unknown arm');})();
export function pairedPlan(tasks){return tasks.flatMap((task,i)=>(i%2?['B','A']:['A','B']).map(arm=>({runKey:`${task.case_id}/0/${arm}`,task,taskSha256:digest(task),arm,repeat:0})));}
export async function codeReceipt(){
 const files=[];
 async function walk(dir){for(const e of await readdir(join(root,dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else if(/\.(ts|mjs|json|sql)$/.test(p))files.push(p);}}
 for(const dir of ['src','integrations/pi/src','integrations/tree-sitter/src'])await walk(dir);
 for(const e of await readdir(join(root,'eval/real')))if(e.endsWith('.mjs'))files.push('eval/real/'+e);
 files.push('package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json','integrations/tree-sitter/grammars/python.lock.json');
 return Promise.all(files.sort().map(async path=>({path,sha256:sha256(await readFile(join(root,path)))})));
}
export async function verifyLock(lock,output){
 assert.equal(lock.protocol,'gpt-paired-ab-2','Budget policy changed: freeze a new experiment; do not append to historical attempts');
 assert.deepEqual(lock.budgetPolicy,new ReviewBudget({limit:lock.maxTools,timeoutMs:lock.timeoutMs,started:0,used:()=>0,now:()=>0}).state(),'Budget policy drift');
 const body={...lock};delete body.experimentSha256;assert.equal(digest(body),lock.experimentSha256,'Experiment drift');assert.equal(resolve(output),lock.outputDirectory);
 assert.deepEqual(lock.model,model);assert.deepEqual(lock.inference,inference);assert.equal(lock.attemptPolicy,'first_attempt');
 for(const file of lock.code)assert.equal(sha256(await readFile(join(root,file.path))),file.sha256,'Code drift: '+file.path);
 for(const c of lock.cases)assert.equal(sha256(await readFile(join(output,'state','snapshots',c.snapshotId+'.json'))),c.snapshotSha256,'Snapshot drift');
}
export function checkPayload(p,arm){assert.equal(p.model,model.modelId);assert.equal(p.reasoning?.effort,'max');assert.deepEqual(p.tools.map(t=>t.name).sort(),['read_diff','read_source','search_text','submit_review',...(arm==='B'?['expand_structural_candidate']:[])].sort());}
