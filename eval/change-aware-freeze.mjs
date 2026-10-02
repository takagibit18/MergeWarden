import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {read,model,inference,pairedPlan,codeReceipt} from './real/ab-contract.mjs';
import {digest} from './real/open-label.mjs';
import {sha256} from '../src/infrastructure/files.ts';
import {ReviewBudget} from '../src/engine/budget.ts';
const out=resolve(process.argv[2]),offline=await read(join(out,'offline-replay.json'));assert.equal(offline.gate.status,'PASS');
const prepared=await read(join(out,'prepared-cases.json')),manifest=await read(join(out,'e2e-case-manifest.json'));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','Freeze only clean implementation commit');
const code=await codeReceipt();for(const path of ['eval/change-aware-prepare.mjs','eval/change-aware-replay.mjs','eval/change-aware-freeze.mjs','eval/change-aware-summary.mjs'])code.push({path,sha256:sha256(await readFile(path))});
const identity={schemaVersion:1,identity:manifest.identity,protocol:'gpt-paired-ab-2',changeAware:true,implementationCommit:commit,kind:'formal',attemptPolicy:'first_attempt',readiness:'OFFLINE_GATE_PASSED',outputDirectory:out,model,inference,modelCapability:prepared.oldModelCapability,modelApi:'openai-codex-responses',modelBaseUrl:'https://chatgpt.com/backend-api',timeoutMs:600000,maxTools:100,outputTokenLimitEnforced:false,
 corpusId:prepared.corpusId,corpusSha256:prepared.corpusSha256,tasks:prepared.tasks,cases:prepared.cases,plan:pairedPlan(prepared.tasks),checkpointPairs:8,code,
 budgetPolicy:new ReviewBudget({limit:100,timeoutMs:600000,started:0,used:()=>0,now:()=>0}).state(),
 versions:{graphSchema:4,resolver:'python-entities-streaming-5',dispatch:'structural-dispatch-2',navigation:'change-aware-structural-1',declarations:'declaration-change-1',closeout:'review-closeout-1'},
 arms:{A:'same declaration-aware deterministic routing and prompt; record intent; text tools only',B:'same routing and prompt plus Graph vNext candidate catalog, optional one prefetch per investigation, optional model expansion'},
 rules:{repeat:1,providerRetries:0,agentRetries:0,autoCompaction:false,graphMode:'prepared_only',privateLabels:false,preRegisteredTargets:false,selection:manifest.selectionRule,scoring:manifest.scoring,
  pilot:{cases:8,runs:16,minimumCompleted:12,minimumCompletedPerArm:6,minimumBActivated:3},stop:'After pilot if thresholds fail; stop early after two mechanical safety failures; otherwise complete 32 first attempts and stop. No tuning, replacement or retries.',bounds:{investigations:2,nodes:30,edges:200,states:200,sharedAcrossTargets:true,prefetchPerInvestigation:1,packageBytes:24576},caseManifestSha256:sha256(await readFile(join(out,'e2e-case-manifest.json'))),offlineReplaySha256:sha256(await readFile(join(out,'offline-replay.json')))}};
identity.experimentSha256=digest(identity);await writeFile(join(out,'experiment.json'),JSON.stringify(identity,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({identity:identity.identity,implementationCommit:commit,experimentSha256:identity.experimentSha256,runs:32,model,inference}));
