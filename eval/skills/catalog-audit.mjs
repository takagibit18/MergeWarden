// Read-only applicability audit. No model, learning, gold, or conclusions about quality.
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {freezeSkills,catalog} from '../../src/skills/context.ts';
import {writeJson} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),tasks=(await readFile(join(root,'corpus/public/tasks.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),snapshots=[];
for(const f of await readdir(join(root,'prepared/snapshots')))snapshots.push(JSON.parse(await readFile(join(root,'prepared/snapshots',f),'utf8')));
const rows=[];
for(const task of tasks){const m=snapshots.find(m=>m.identity.baseCommit===task.base_sha&&m.identity.headCommit===task.reviewed_sha);if(!m)throw Error('Missing immutable source');const store=await SnapshotStore.load(join(root,'prepared'),m.identity.id);
for(const arm of ['B','C']){const pkg=await freezeSkills(join(root,'execution',arm),store,'auto','github:'+task.repository);rows.push({caseId:task.case_id,arm,snapshotId:m.identity.id,bankSnapshotId:pkg.bankSnapshotId,eligible:pkg.eligible,catalog:catalog(pkg),degraded:pkg.degraded??null});}}
await writeJson(join(root,'summary/catalog-applicability.json'),{kind:'Offline selection only; no actual body consumption or review-quality evidence',rows});console.log(JSON.stringify(rows.map(r=>({caseId:r.caseId,arm:r.arm,eligible:r.eligible,catalog:r.catalog.length}))));
