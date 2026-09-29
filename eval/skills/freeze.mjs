// Curator stage: private labels never enter the public execution manifest.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,link,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {SqliteCodeGraph,publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
import {codeReceipt,referenceRun} from '../real/ab-contract.mjs';
const root=resolve(process.argv[2]),read=async p=>JSON.parse(await readFile(p,'utf8'));
assert.equal((await read(join(root,'stage-a.json'))).status,'PASS');
const inventory=await read(join(root,'corpus/private/inventory.json'));
const audit=await read(join(root,'curator-audit.json'));
assert.equal(audit.length,inventory.length);
const gold=[],provenance=[];
for(const c of inventory){const a=audit.find(a=>a.id===c.id);assert(a?.rationale&&a.counterevidence);const pages=await read(join(root,'corpus/private/audit',c.id,'source.json'));gold.push({id:c.id,label:c.label,theme:c.theme,...a,evidence:pages.map(p=>p.exact),reviewer:'Codex static source inspection',humanReviewed:false,seen_in_prior_dev:true});provenance.push({id:c.id,source:c.source,task:c.task,contaminationGroup:c.contaminationGroup,diffSha256:c.diffSha256,sourcePagesSha256:sha256(JSON.stringify(pages)),seen_in_prior_dev:true});}
assert.equal(new Set(inventory.map(c=>c.contaminationGroup)).size,inventory.length);
assert.equal(new Set(inventory.map(c=>c.diffSha256)).size,inventory.length);
const episodes=(await readFile(join(root,'corpus/private/episodes.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
for(const e of episodes){const s=inventory.find(c=>c.id===e.source),t=inventory.find(c=>c.id===e.transfer);assert.equal(s.task.repository,t.task.repository);assert(s.committedAt<t.committedAt);assert.notEqual(s.diffSha256,t.diffSha256);}
for(const [name,rows]of [['gold.jsonl',gold],['provenance.jsonl',provenance]])await writeFile(join(root,'corpus/private',name),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const paths=['public/tasks.jsonl','private/gold.jsonl','private/provenance.jsonl','private/splits.json','private/episodes.jsonl','private/feedback-policy.json'];
await writeJson(join(root,'corpus/corpus.lock.json'),{status:'FROZEN',at:new Date().toISOString(),files:await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(join(root,'corpus',path)))}))),formalQualityRunsAuthorized:false,limitations:['Historical development exposure','Static curator review, no independent human gold','Near counterexamples are thematic, not identical API negatives']});
const cases=[];
for(const c of inventory.filter(c=>['source','pilot'].includes(c.split))){const store=await SnapshotStore.load(join(root,'prepared'),c.snapshotId);const built=await SqliteCodeGraph.open(store,{scope:'core'});built.graph.close();const hot=await SqliteCodeGraph.openPublishedOnly(store,{scope:'core'});hot.graph.close();const seedId=randomUUID();await mkdir(join(root,'prepared/runs',seedId),{recursive:true});await writeJson(join(root,'prepared/runs',seedId,'run.json'),referenceRun(seedId,c.snapshotId));cases.push({caseId:c.id,split:c.split,task:c.task,repositoryPath:c.repositoryPath,skillRepositoryKey:c.skillRepositoryKey,snapshotId:c.snapshotId,seedId,graphSha256:sha256(await readFile(await publishedGraphPath(join(root,'prepared'),c.snapshotId))),generationId:hot.manifest.generationId});console.log(JSON.stringify({prepared:c.id}));}
// Hard link only immutable blobs; mutable banks, graph metadata and run records stay separate.
async function clone(src,dst,blobs=false){await mkdir(dst,{recursive:true});for(const e of await readdir(src,{withFileTypes:true})){const s=join(src,e.name),d=join(dst,e.name);if(e.isDirectory())await clone(s,d,blobs||e.name==='blobs');else if(blobs)await link(s,d);else await copyFile(s,d);}}
for(const arm of ['A','B','C'])await clone(join(root,'prepared'),join(root,'execution',arm));
const code=await codeReceipt();for(const f of await readdir(new URL('.',import.meta.url)))if(f.endsWith('.mjs'))code.push({path:'eval/skills/'+f,sha256:sha256(await readFile(new URL(f,import.meta.url)))});
await mkdir(join(root,'execution/context'),{recursive:true});
await writeJson(join(root,'execution/experiment.json'),{protocol:'skill-evolution-pilot-1',createdAt:new Date().toISOString(),model:{provider:'openai-codex',modelId:'gpt-5.6-luna'},inference:{thinkingLevel:'max',maxOutputTokens:32768},timeoutMs:600000,maxToolCalls:100,attemptPolicy:'first_attempt',code,cases,reviewCallsPrior:2,reviewCallsMax:20,learningCallsPrior:1,learningCallsMax:24,commentCallsMax:6,adjudicationCallsMax:12,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2',declarationAware:true},pilotOrder:['A','B','C','B','C','A','C','A','B','A','C','B'],corpusLockSha256:sha256(await readFile(join(root,'corpus/corpus.lock.json')))});
console.log('Frozen source and pilot execution; private labels excluded.');
