import {join,resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
import {read,save,identity,EXPERIMENT} from './common.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..'),files=[];
async function walk(dir,filter=()=>true){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p,filter);else if(filter(p))files.push(await identity(p));}}
for(const name of ['protocol.json','case-manifest.json','run-config.json'])files.push(await identity(join(out,name)));
for(const name of ['package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json'])files.push(await identity(join(repo,name)));
await walk(join(out,'public'));await walk(join(repo,'src'),p=>p.endsWith('.ts'));await walk(join(repo,'integrations/pi/src'));await walk(join(repo,'eval/microeval'));
await walk(join(out,'state/snapshots'));await walk(join(out,'state/graphs'));
const denied=[join(out,'private'),join(out,'preparation-v1'),join(out,'admission'),join(out,'../changeunit-semantic-intent-shadow-20260926'),join(out,'../real-route-recall-diagnostic-20260925'),join(out,'../full-context-candidate-dataset-20260925')];
await save(join(out,'input-freeze.json'),{identity:EXPERIMENT,createdAt:new Date().toISOString(),files,denied,privateTargetContentsExcluded:true,realModelRuns:0});
console.log(JSON.stringify({frozen:files.length,realModelRuns:0}));
