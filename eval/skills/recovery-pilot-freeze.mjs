import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SkillBank,digest} from '../../src/skills/bank.ts';
import {freezeSkills,savePackage} from '../../src/skills/context.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),dir=join(root,'execution'),read=async p=>JSON.parse(await readFile(p,'utf8')),ex=await read(join(dir,'experiment.json'));
assert.equal((await read(join(dir,'learning-frozen.json'))).status,'FROZEN');
const bindings=[];
for(const arm of ['B','C']){const state=join(dir,arm),frozen=await read(join(dir,arm+'-frozen.json')),bank=new SkillBank(state);assert.equal((await bank.current()).id,frozen.bankSnapshotId);assert.equal(digest(await bank.skills()),frozen.catalogSha256);
for(const c of ex.cases.filter(c=>c.split==='pilot')){const store=await SnapshotStore.load(state,c.snapshotId),pkg=await freezeSkills(state,store,'auto',c.skillRepositoryKey);assert(!pkg.degraded);assert.equal(pkg.bankSnapshotId,frozen.bankSnapshotId);const seed=await read(join(state,'runs',c.seedId,'run.json')),runId=randomUUID(),runDir=join(state,'runs',runId);await mkdir(runDir);const skills=await savePackage(runDir,pkg);await writeJson(join(runDir,'run.json'),{...seed,runId,skills});bindings.push({caseId:c.caseId,arm,seedId:runId,originalSeedId:c.seedId,skills});}}
await writeJson(join(dir,'pilot-bindings.json'),{status:'FROZEN',order:ex.pilotOrder,bindings,at:new Date().toISOString(),experimentSha256:sha256(await readFile(join(dir,'experiment.json')))});
console.log(JSON.stringify(bindings.map(b=>({caseId:b.caseId,arm:b.arm,eligible:b.skills.eligible,selected:b.skills.available.length}))));
