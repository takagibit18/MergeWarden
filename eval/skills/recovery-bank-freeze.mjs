import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SkillBank,digest} from '../../src/skills/bank.ts';
import {writeJson} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),arm=process.argv[3],dir=join(root,'execution'),state=join(dir,arm),read=async p=>JSON.parse(await readFile(p,'utf8'));assert(['B','C'].includes(arm));
const bank=new SkillBank(state),current=await bank.current(),skills=await bank.skills(),records=[];
for(const file of await readdir(join(state,'skills/jobs'))){const j=await read(join(state,'skills/jobs',file));assert(!['pending','running'].includes(j.status));records.push(j);}
await writeJson(join(dir,arm+'-frozen.json'),{status:'FROZEN',bankSnapshotId:current.id,catalogSha256:digest(skills),skills,records,at:new Date().toISOString()});
if(arm==='C')await writeJson(join(dir,'learning-frozen.json'),{status:'FROZEN',B:await read(join(dir,'B-frozen.json')),C:await read(join(dir,'C-frozen.json'))});
console.log(JSON.stringify({arm,skills:skills.length,states:skills.map(s=>s.state),jobs:records.map(j=>({id:j.id,status:j.status,attempts:j.attempts}))}));
