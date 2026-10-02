import {join,resolve,toNamespacedPath} from 'node:path';
import {mkdir,readdir,realpath,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {MODEL_CONFIG,EXPERIMENT} from './contracts.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..');
assert.equal((await read(join(out,'public-admission.json'))).status,'PASS');
const generation=await read(join(out,'phase-a/generation-freeze.json')),preparation=await read(join(out,'public-preparation-freeze.json'));await checkIdentities(generation.files);await checkIdentities(preparation.files);
assert.ok(process.env[MODEL_CONFIG.apiKeyEnv]?.trim(),'Explicit model API key env missing');
const publicFiles=[];for(const name of ['input-hashes.json','case-order.json','model-config.json','schema.json','prompt.txt','prompt-sha.json'])publicFiles.push(await identity(join(out,'phase-a',name)));
for(const e of await read(join(out,'phase-a/input-hashes.json')))publicFiles.push(e.file);
const banned=new Set(['targetPath','necessaryTarget','necessaryFact','gold','goldFinding','label','privateLabel','candidateCatalog','oracleSuccessfulPairs','previousPrediction','entityId']);
const audit=[];function inspect(value,path=''){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){assert.ok(!banned.has(key),'Forbidden semantic input key: '+path+'.'+key);inspect(item,path+'.'+key);}}
for(const f of publicFiles.filter(f=>f.path.includes('semantic-inputs'))){const input=await read(f.path);inspect(input);assert.match(input.caseId,/^SR\d{2}$/);assert.equal(input.routerState.outcome,'NO_ROUTE');audit.push({input:f.path,hash:f.sha256,projectionWhitelist:true,forbiddenKeys:false});}
const implementation=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else implementation.push(await identity(p));}}
await walk(import.meta.dirname);await walk(join(repo,'src'));await walk(join(repo,'integrations/pi/src'));implementation.push(await identity(join(repo,'eval/candidate-dataset-context.mjs')),await identity(join(repo,'integrations/pi/package-lock.json')));
await save(join(out,'anti-leakage-public.json'),{status:'PASS',privateTargetsOpened:false,privatePermissionDenied:true,previousSemanticPredictionsOpened:false,checks:audit,limitation:'This is a provenance/whitelist audit before private unblinding; target-string comparison is deferred until prediction freeze.'});
const denied=[...preparation.denied,join(out,'universe.json'),join(out,'public-admission.json'),join(out,'phase-a/prefixes'),join(out,'phase-a/change-units')];
await save(join(out,'phase-a/experiment-freeze.json'),{identity:EXPERIMENT,publicFiles,implementation,denied,model:MODEL_CONFIG,orderHash:hash(await readFile(join(out,'phase-a/case-order.json'))),firstAttemptOnly:true,secretSerialized:false});
await mkdir(join(out,'phase-b'));
const allowed=[import.meta.dirname,join(repo,'eval/candidate-dataset-context.mjs'),join(repo,'src'),join(repo,'integrations/pi/src'),join(repo,'integrations/pi/package.json'),join(repo,'integrations/pi/package-lock.json'),join(repo,'integrations/pi/node_modules'),await realpath(join(repo,'integrations/pi/node_modules')),join(repo,'node_modules'),await realpath(join(repo,'node_modules')),join(repo,'package.json'),join(out,'phase-a/experiment-freeze.json'),...publicFiles.map(f=>f.path),join(out,'phase-b')];
const paths=[...new Set(allowed.flatMap(p=>[p,toNamespacedPath(p)]))];await save(join(out,'phase-b-access-policy.json'),{read:paths,write:[join(out,'phase-b')],denied,child:false,endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions',maxRequestsPerCase:1});
const child=spawn(process.execPath,['--experimental-strip-types','--preserve-symlinks','--permission',...paths.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(out,'phase-b'),join(import.meta.dirname,'run.mjs'),out],{cwd:repo,env:process.env,stdio:'inherit'});
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});await save(join(out,'model-process-exit.json'),{exit:code});assert.equal(code,0);await checkIdentities(publicFiles);await checkIdentities(implementation);
