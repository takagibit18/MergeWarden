import {readFile,mkdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareTask,freezeTask,objectGit,validateTask} from './adapter.mjs';
import {isolatedState,writeJson,sha256} from '../../src/infrastructure/files.ts';
import {ReviewEngine} from '../../src/engine/review.ts';
import {readRun} from '../../src/engine/reports.ts';
import {analyzeRetrieval} from '../../src/experiments/locagent/traces.ts';
const args=process.argv.slice(2),get=k=>{const n=args.indexOf(k);return n<0?undefined:args[n+1];};
if(!get('--selection')||!get('--output')||args.includes('--live'))throw Error('Use --selection PUBLIC_SELECTION_JSON --output OUTSIDE_CHECKOUT [--repositories CACHE] [--offline]. No live model calls are supported by this preflight.');
const selectionBytes=await readFile(resolve(get('--selection')),'utf8');
const selection=JSON.parse(selectionBytes);if(!Array.isArray(selection.tasks)||!selection.tasks.length)throw Error('Expected public tasks');
selection.tasks.forEach(validateTask);
if(new Set(selection.tasks.map(t=>t.case_id)).size!==selection.tasks.length)throw Error('Duplicate task IDs');
const root=fileURLToPath(new URL('../../',import.meta.url)),output=await isolatedState(resolve(get('--output')),root);
await (await open(join(output,'probe.lock'),'wx')).close();
const repositories=await isolatedState(resolve(get('--repositories')??join(output,'repositories')),root);
await mkdir(repositories,{recursive:true});
const result={schemaVersion:1,kind:'real-git-static-preflight',selectionSha256:sha256(selectionBytes),paidModelCalls:0,projectCodeExecuted:false,qualityMeasured:false,formalABReady:false,cases:[]};
await writeJson(join(output,'result.json'),result);
for(const task of selection.tasks) {
 const entry={caseId:task.case_id,repository:task.repository,baseSha:task.base_sha,headSha:task.reviewed_sha,status:'error',runs:[]};
 try {
  const repository=await prepareTask(task,join(repositories,task.case_id));
  const start=performance.now(),state=join(output,'state'),model={provider:'fixture',modelId:'offline'};
  const store=await freezeTask(task,{repositoryPath:repository,stateDir:state,configuration:{...model,policy:'final_only',promptVersion:1}});
  entry.snapshotMs=performance.now()-start;entry.snapshotId=store.manifest.identity.id;entry.changedPaths=store.manifest.changedPaths;
  entry.files={base:Object.keys(store.manifest.base).length,head:Object.keys(store.manifest.head).length,pythonHead:Object.keys(store.manifest.head).filter(p=>p.endsWith('.py')).length};
  entry.minimumDiffToolCalls=0;
  for(const path of store.manifest.changedPaths) {
   let offset=0;
   while(true) {const page=await store.diff(path,offset,200);if(page.status!=='ok')throw Error('Diff unavailable for '+path);entry.minimumDiffToolCalls++;if(!page.truncated)break;if(page.nextCursor<=offset)throw Error('Diff made no progress');offset=page.nextCursor;}
  }
  entry.minimumToolsIncludingSubmit=entry.minimumDiffToolCalls+1;
  entry.parents=(await objectGit(repository,['cat-file','-p',task.reviewed_sha])).toString().split('\n').filter(s=>s.startsWith('parent ')).map(s=>s.slice(7));
  entry.status='snapshot_ready_scope_and_gold_still_require_audit';
  if(args.includes('--offline')) {
   const {createPiRuntime}=await import('../../integrations/pi/src/runtime.ts');
   const {offlineProvider}=await import('../offline-provider.mjs');
   // Fixed plumbing budget, not a proposed live budget. No gold reaches the SDK.
   for(const arm of ['text-only','text+graph']) {
    const runtime=await offlineProvider(store.manifest.changedPaths,'__real_corpus_probe__');
    const started=performance.now();
    const reviewed=await new ReviewEngine(o=>createPiRuntime(o,runtime)).run({repositoryPath:repository,stateDir:state,input:{kind:'commits',base:task.base_sha,head:task.reviewed_sha},model,timeoutMs:600000,maxToolCalls:1000,evaluation:{tools:arm}});
    if(reviewed.kind!=='report'||reviewed.report.snapshot.id!==entry.snapshotId)throw Error('Result/snapshot drift');
    const native=await readFile(join(state,'runs',reviewed.runId,'session.jsonl'),'utf8');
    entry.runs.push({arm,runId:reviewed.runId,status:reviewed.report.status,latencyMs:performance.now()-started,report:reviewed.report,manifest:await readRun(state,reviewed.runId),trace:analyzeRetrieval({runKey:task.case_id+'/'+arm,snapshotId:entry.snapshotId,findings:reviewed.report.findings,changedPaths:Object.keys(reviewed.report.coverage),jsonl:native})});
    await writeJson(join(output,task.case_id+'.json'),entry);
   }
  }
 } catch(error) {entry.error=String(error.message).slice(0,2000);}
 result.cases.push(entry);await writeJson(join(output,'result.json'),result);
 console.error(entry.caseId,entry.status,entry.error??'');
}
console.log(JSON.stringify({output,cases:result.cases.length,snapshots:result.cases.filter(c=>c.snapshotId).length,paidModelCalls:0,formalABReady:false}));
