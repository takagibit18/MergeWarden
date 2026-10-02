import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {buildInvestigationQuery} from '../src/experiments/locagent/investigation-query.ts';
const out=resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex'),read=async n=>JSON.parse(await readFile(join(out,n),'utf8')),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
assert.ok(process.permission);
for(const i of await read('frozen-inputs.json'))if(i.role.includes('scorer')||i.role.includes('projection only')||i.role==='source replay only')assert.equal(process.permission.has('fs.read',i.path),false);
const rows=(await read('preselection-observations.json')).map(r=>({id:r.id,...buildInvestigationQuery(r.observations),observationLimit:r.observationLimit}));
await save('investigation-query.json',rows);
await save('query-freeze.json',{frozenAt:new Date().toISOString(),beforeRelevanceImplementation:true,sourceSha256:hash(await readFile(new URL('../src/experiments/locagent/investigation-query.ts',import.meta.url))),artifacts:await Promise.all(['protocol.json','preselection-observations.json','investigation-query.json'].map(async name=>({name,sha256:hash(await readFile(join(out,name)))}))),auditReadable:false});
console.log(JSON.stringify(rows.map(r=>({id:r.id,tokens:r.tokens}))));
