import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {read,model,inference,pairedPlan,codeReceipt,referenceRun} from './real/ab-contract.mjs';
import {digest} from './real/open-label.mjs';
import {sha256,writeJson} from '../src/infrastructure/files.ts';
import {ReviewBudget} from '../src/engine/budget.ts';
import {publishedGraphPath} from '../src/graph/sqlite-store.ts';
const out=resolve(process.argv[2]),prior=resolve('../output/luna-max-ab-20260928-v2');
const old=await read(join(prior,'experiment.json'));
assert.deepEqual(old.model,model);assert.deepEqual(old.inference,inference);
const universePath=resolve('../output/real-route-recall-diagnostic-20260925/universe.json');
// Historical stratum projection ONLY. No private targets or retrieval outcomes enter selection.
const historical=(await read(universePath)).plans.map(p=>({id:p.caseId,label:p.group==='CLEAN_CONTROL'?'clean':'cross_file'}));
const exclude=['RG2-0a5e7051ef8a','RG2-0bed4078bcc8','RG2-1193c136a605','RG2-11daca5ebd13'];
const buckets={cross_file:[],defect:[],clean:[]};
for(const task of [...old.tasks].sort((a,b)=>a.case_id.localeCompare(b.case_id))){
 if(exclude.includes(task.case_id))continue;
 const label=historical.find(p=>p.id===task.case_id)?.label??'defect';buckets[label].push(task.case_id);
}
const chosen=[...buckets.cross_file.slice(0,4),...buckets.defect.slice(0,2),...buckets.clean.slice(0,2),...buckets.cross_file.slice(4,8),...buckets.defect.slice(2,4),...buckets.clean.slice(2,4)];
assert.equal(chosen.length,16);assert.equal(new Set(chosen).size,16);
const selection={identity:'change-aware-structural-20260928',createdAt:new Date().toISOString(),selectionRule:'Exclude four development cases. Project historical stratum membership only, discard prior route HIT/MISS suffix and all outcomes. Sort IDs lexically within strata; first 8 cross-file, 4 local defect, 4 clean. Pilot takes first 4/2/2 and continuation the remaining 4/2/2. Never replace a case.',excluded:exclude,source:{path:universePath,sha256:sha256(await readFile(universePath))},
 cases:chosen.map((id,i)=>({caseId:id,stratum:Object.keys(buckets).find(k=>buckets[k].includes(id)),phase:i<8?'pilot':'continuation'})),
 scoring:{version:'paired-semantic-audit-1',predictionFreezeRequired:true,defectHit:'A reported finding must identify the same introduced contract violation as a frozen reference, with compatible trigger and observable impact, supported by inspected evidence. Mere file/range overlap is insufficient. Count each defect case at most once; uncompleted runs remain in all-case denominators.',crossFileHit:'Same rule on the preselected cross_file stratum.',cleanFP:'Count clean cases with at least one unsupported finding after source audit; clean labels are static agent labels, not proof of no bugs.',relevantSource:'After predictions freeze, audit actual provider-delivered source containing a required private context range, then confirm semantic relevance. Hash and snapshot must match; previews and unexposed host packages do not count. Untouched means source range not changed; cross-file reported separately.',operations:'Count host Graph operations plus host/model source reads from the triggering route through the first delivered relevant source; ordinary searches reported separately. Unreached is false with null operation count.',unknownUsage:'Missing usage stays null. Report known partial usage separately, never as a complete token total.',auditor:'Agent semantic source audit; not independent human adjudication.'}};
await writeFile(join(out,'e2e-case-manifest.json'),JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
const copied=new Set();const copy=async(a,b)=>{if(copied.has(b))return;await mkdir(dirname(b),{recursive:true});await copyFile(a,b);copied.add(b);};
const cases=[];
for(const id of chosen){
 const c=old.cases.find(c=>c.caseId===id);assert(c);const manifest=await read(join(prior,'state/snapshots',c.snapshotId+'.json'));
 await copy(join(prior,'state/snapshots',c.snapshotId+'.json'),join(out,'state/snapshots',c.snapshotId+'.json'));
 for(const f of [...Object.values(manifest.base),...Object.values(manifest.head)])if(f.status==='text')await copy(join(prior,'state/blobs',f.hash),join(out,'state/blobs',f.hash));
 const db=await publishedGraphPath(join(prior,'state'),c.snapshotId),graphDir=dirname(dirname(db));
 await copy(db,join(out,'state',relative(join(prior,'state'),db)));
 await copy(join(graphDir,'published.json'),join(out,'state',relative(join(prior,'state'),join(graphDir,'published.json'))));
 await writeJson(join(out,'state/runs',c.seedId,'run.json'),referenceRun(c.seedId,c.snapshotId));cases.push(c);
 console.log(JSON.stringify({prepared:id,copied:copied.size}));
}
await writeJson(join(out,'prepared-cases.json'),{cases,tasks:chosen.map(id=>old.tasks.find(t=>t.case_id===id)),oldModelCapability:old.modelCapability,corpusId:old.corpusId,corpusSha256:old.corpusSha256});
