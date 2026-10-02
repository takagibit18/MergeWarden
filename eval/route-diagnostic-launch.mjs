import {readdir,realpath,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities} from './candidate-dataset-context.mjs';
const phase=process.argv[3]??'phase-a';assert.ok(/^phase-a(?:-v[0-9]+)?$/.test(phase));const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'..'),workspace=resolve(out,'../..'),{plans}=await read(join(out,'universe.json'));
await checkIdentities(await read(join(out,'frozen-inputs.json')));
const paths=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(/\.(ts|json)$/.test(p))paths.push(p);}}
await walk(join(repo,'src'));await walk(join(repo,'integrations/pi/src'));await walk(join(repo,'integrations/tree-sitter/src'));
const modules=['route-diagnostic-prepare.mjs','route-diagnostic-replay.mjs','route-observable-features.mjs','route-diagnostic-run.mjs','route-diagnostic-launch.mjs','candidate-dataset-context.mjs'].map(n=>join(repo,'eval',n));paths.push(...modules,join(repo,'package.json'),join(repo,'integrations/tree-sitter/grammars/python.lock.json'));
const grammar=join(repo,'integrations/tree-sitter/node_modules/tree-sitter-python/tree-sitter-python.wasm');paths.push(grammar,join(repo,'integrations/tree-sitter/node_modules/web-tree-sitter/web-tree-sitter.js'));
const privatePaths=[join(workspace,'output/realgolden40-closure/corpus-v1-final/hidden/gold.jsonl'),join(workspace,'output/realgolden40-closure/corpus-v1-final/audit/receipts.jsonl'),join(workspace,'bounded-structural-retrieval-v1/private/audit-v2.json'),join(out,'phase-b/private-labels.json')];
const files=await Promise.all(paths.map(identity));await save(join(out,phase==='phase-a'?'implementation-sha.json':'implementation-sha-'+phase+'.json'),{files,privatePaths});await mkdir(join(out,phase),{recursive:true});
const allowed=[...paths,join(repo,'src'),join(repo,'integrations/pi/src'),join(repo,'integrations/tree-sitter'),await realpath(join(repo,'integrations/tree-sitter/node_modules')),join(repo,'integrations/tree-sitter/node_modules'),join(repo,'integrations/tree-sitter/package.json'),join(repo,'integrations/pi/package.json'),join(out,'registered-prefixes'),join(out,phase),join(out,'protocol.json'),join(out,'universe.json'),join(out,phase==='phase-a'?'implementation-sha.json':'implementation-sha-'+phase+'.json')];
for(const p of plans.filter(p=>p.group==='CLEAN_CONTROL'))allowed.push(join(p.state,'snapshots',p.snapshotId+'.json'),join(p.state,'blobs'));
const args=['--experimental-strip-types','--permission',...[...new Set(allowed)].map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(out,phase),join(repo,'eval/route-diagnostic-run.mjs'),out,phase];
await save(join(out,phase+'-access-policy.json'),{read:[...new Set(allowed)],write:[join(out,phase)],denied:privatePaths,graphReadAllowed:false,childProcessAllowed:false});
const result=spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',maxBuffer:2e6});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');assert.equal(result.status,0);
await checkIdentities(await read(join(out,'frozen-inputs.json')));await checkIdentities(files);
