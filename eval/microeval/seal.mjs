import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {read,save,hash,identity,EXPERIMENT} from './common.mjs';
const out=resolve(process.argv[2]),config=await read(join(out,'run-config.json')),done=await read(join(out,'runs-completed.json')),freeze=await read(join(out,'input-freeze.json')),files=[];
assert.equal(done.completed.length,config.runOrder.length);assert.equal(done.allFirstAttemptsFinished,true);
assert.deepEqual(done.completed.map(c=>[c.id,c.arm]),config.runOrder.map(c=>[c.id,c.arm]));
for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(await identity(p));}}
for(const dir of ['arm-a-text','arm-b-graph','state/runs'])await walk(join(out,dir));
for(const name of ['runs-completed.json','run-started.json','input-freeze.json'])files.push(await identity(join(out,name)));
await save(join(out,'prediction-freeze.json'),{identity:EXPERIMENT,createdAt:new Date().toISOString(),allFirstAttemptsFinished:true,runs:done.completed,files,semanticPrivateScoring:'NOT_OPENED'});
console.log(JSON.stringify({frozenRuns:done.completed.length,files:files.length}));
