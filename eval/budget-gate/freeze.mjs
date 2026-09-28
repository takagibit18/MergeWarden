import {join,resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
import {read,save,identity} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),repo=resolve(import.meta.dirname,'../..'),protocol=await read(join(out,'protocol.json')),files=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(await identity(p));}}
for(const n of ['protocol.json','successor-lineage.json','case-manifest.json','run-config.json','baseline-exit.txt'])files.push(await identity(join(out,n)));
for(const n of ['package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json'])files.push(await identity(join(repo,n)));
for(const d of ['src','integrations/pi/src','integrations/tree-sitter/src','eval/microeval','eval/budget-gate'])await walk(join(repo,d));
for(const d of ['public','state/snapshots','state/graphs','state/blobs'])await walk(join(out,d));
await save(join(out,'input-freeze.json'),{identity:protocol.experiment,execution:protocol.execution,createdAt:new Date().toISOString(),files,denied:[join(out,'private'),join(out,'admission.json'),protocol.predecessor,join(out,'../changeunit-semantic-intent-shadow-20260926'),join(out,'../real-route-recall-diagnostic-20260925')],realModelRuns:0});console.log(JSON.stringify({frozen:files.length}));
