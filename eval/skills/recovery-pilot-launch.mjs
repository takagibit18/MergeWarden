import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const repo=resolve(import.meta.dirname,'../..'),root=resolve(process.argv[2]),auth=resolve(process.argv[3]),dir=join(root,'execution'),read=async p=>JSON.parse(await readFile(p,'utf8')),ex=await read(join(dir,'experiment.json')),bindings=await read(join(dir,'pilot-bindings.json'));
assert.deepEqual(bindings.order,ex.pilotOrder);
for(const [i,c] of ex.cases.filter(c=>c.split==='pilot').entries())for(const arm of ex.pilotOrder.slice(i*3,i*3+3)){
try{await access(join(dir,'recovery-stop.json'));throw Error('Recovery stop exists; no further calls');}catch(e){if(e.code!=='ENOENT')throw e;}
const file=join(dir,'reviews',c.caseId+'-'+arm+'.json');try{await access(file);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
const code=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[join(repo,'eval/skills/recovery-launch.mjs'),dir,auth,'pilot',c.caseId,arm],{stdio:'inherit',windowsHide:true});p.on('error',reject);p.on('exit',resolve);});assert.equal(code,0,'Pilot worker failure');
const result=await read(file);assert(result.runId,'No delivered run: stop for inspection');
}
