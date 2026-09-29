import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {repo,read,clone,snapshotCopy,sha256,writeJson} from './exposure-common.mjs';
import {codeReceipt} from '../real/ab-contract.mjs';
import {readReport,readRun} from '../../src/engine/reports.ts';
const root=resolve(process.argv[2]),previous=resolve(process.argv[3]),old=await read(join(previous,'execution/experiment.json'));
await mkdir(join(root,'execution'),{recursive:true});assert(!(await readdir(join(root,'execution'))).length,'Successor already initialized');
const allowed=new Set(['src/skills/contracts.ts','src/skills/bank.ts','src/skills/context.ts','src/skills/learning.ts','integrations/pi/src/learning.ts']);
for(const f of old.code){const current=await readFile(join(repo,f.path));const archive=allowed.has(f.path)?await readFile(join(root,'previous-code',f.path)):current;assert.equal(sha256(archive),f.sha256,'Old code cannot be reconstructed: '+f.path);await mkdir(dirname(join(root,'previous-code',f.path)),{recursive:true});await writeFile(join(root,'previous-code',f.path),archive);if(!allowed.has(f.path))assert.equal(sha256(current),f.sha256,'Forbidden implementation change');}
const sources=[];const refs=(await readFile(join(previous,'corpus/private/gold.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
for(const c of old.cases.filter(c=>c.split==='source')){const record=await read(join(previous,'execution/reviews',c.caseId+'-A.json'));if(record.status!=='completed'||!record.manifest.termination.finalSubmission)continue;
 const state=join(previous,'execution/A'),m=await readRun(state,record.runId),report=await readReport(state,record.runId);assert.equal(report.status,'completed');
 await clone(join(state,'runs',record.runId),join(root,'sources/runs',record.runId));await snapshotCopy(state,join(root,'sources'),m.snapshotId);
 await writeJson(join(root,'source-audit',c.caseId+'.json'),{task:c.task,report,reference:refs.find(r=>r.id===c.caseId),diff:await readFile(join(previous,'corpus/private/audit',c.caseId,'change.diff'),'utf8'),pages:await read(join(previous,'corpus/private/audit',c.caseId,'source.json'))});
 sources.push({...c,runId:record.runId,reportSha256:m.reportSha256,sessionSha256:sha256(await readFile(join(state,'runs',record.runId,'session.jsonl')))});
}
assert.equal(sources.length,3);const code=await codeReceipt();for(const f of await readdir(join(repo,'eval/skills')))if(f.endsWith('.mjs'))code.push({path:'eval/skills/'+f,sha256:sha256(await readFile(join(repo,'eval/skills',f)))});
await writeJson(join(root,'execution/experiment.json'),{protocol:'skill-exposure-1',createdAt:new Date().toISOString(),previous,previousExperimentSha256:sha256(await readFile(join(previous,'execution/experiment.json'))),previousFinalSha256:sha256(await readFile(join(previous,'summary/final-recovery.json'))),model:old.model,inference:old.inference,evaluation:old.evaluation,timeoutMs:old.timeoutMs,maxToolCalls:old.maxToolCalls,learningTimeoutMs:120000,attemptPolicy:'first_attempt_no_retry',budgets:{review:9,learning:20,comments:3,adjudication:10},priorConsumed:{review:20,learning:4,comments:3,adjudication:2},sources,code,scopePolicy:'repo/language hard; review_method path/symbol/concepts soft; repository_fact path hard',gates:{learningLegalDecisions:2,feedbackMinimum:1,exposureLoadedMinimum:1},targetPolicy:'Select 2 real PRs (transfer + near-clean), optional third only with preflight justification. Freeze before any Review. No source reruns, no formal or repeats.'});
await mkdir(join(root,'execution/context'),{recursive:true});console.log(JSON.stringify({status:'FROZEN',sources:sources.map(s=>s.caseId),code:code.length}));
