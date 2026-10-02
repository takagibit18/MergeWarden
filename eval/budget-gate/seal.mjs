import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {read,save,identity,hash} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),config=await read(join(out,'run-config.json')),done=await read(join(out,'runs-completed.json')),inputs=await read(join(out,'input-freeze.json')),files=[];
assert(done.allFirstAttemptsFinished);assert.equal(done.completed.length+done.notRun.length,2);assert(done.completed.every(c=>c.id==='D1'));for(const f of inputs.files)assert.equal(hash(await readFile(f.path)),f.sha256);
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name!=='prediction-freeze.json')files.push(await identity(p));}}
await walk(out);await save(join(out,'prediction-freeze.json'),{identity:config.identity,execution:config.execution,createdAt:new Date().toISOString(),allFirstAttemptsFinished:true,runs:done.completed,notRun:done.notRun,files,semanticPrivateScoring:'NOT_OPENED'});console.log(JSON.stringify({frozen:files.length,runs:done.completed.length,notRun:done.notRun.length}));
