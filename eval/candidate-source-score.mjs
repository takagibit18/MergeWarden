import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const out=resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8')),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const freeze=await read(join(out,'source-freeze.json'));assert.equal(hash(await readFile(join(out,'source-replay.json'))),freeze.sha256);
const ids=await read(join(out,'frozen-inputs.json')),identity=ids.find(i=>i.role==='post-freeze scorer only'),bytes=await readFile(identity.path);assert.equal(hash(bytes),identity.sha256);
const audit=JSON.parse(bytes).cases,metrics=await read(join(out,'selection-score.json')),replays=await read(join(out,'source-replay.json')),units=await read(join(out,'candidate-units.json'));
for(const m of metrics){const replay=replays.find(r=>r.id===m.id),a=audit.find(a=>a.id===m.id),pool=units.find(u=>u.id===m.id).eligible;
 for(const t of m.targets){const source=replay.candidates.find(c=>c.terminalEntityId===t.targetId),unit=pool.find(u=>u.terminalEntityId===t.targetId),facts=unit?a.necessaryFacts.filter(f=>f.path===unit.terminalPath&&f.startLine<=unit.sourceRange.endLine&&f.endLine>=unit.sourceRange.startLine):a.necessaryFacts;
  t.sourceRead=source?.sourceRead??false;t.sourcePackaged=source?.sourcePackaged??false;t.necessaryFactCovered=facts.length>0&&facts.every(f=>replay.pack.sources.some(s=>s.path===f.path&&s.startLine<=f.startLine&&s.endLine>=f.endLine));t.sourceRange=source?.sourceRange??null;t.sourceBytes=source?.sourceBytes??0;t.evidenceRefId=source?.evidenceRefId??null;t.downstreamExecution='FROZEN_FIXED_WINDOW_REPLAY_NO_MODEL';
  t.failureStage=!t.edgeInspected?'F0_NOT_INSPECTED':!t.entityReached?'F1_EDGE_INSPECTED_ENTITY_NOT_REACHED':!t.pathRetained?'F2_ENTITY_REACHED_PATH_NOT_RETAINED':!t.candidateSelected?'F3_PATH_RETAINED_CANDIDATE_DROPPED':!t.sourceRead?'F4_CANDIDATE_SELECTED_SOURCE_NOT_READ':!t.necessaryFactCovered?'F5_SOURCE_READ_FACT_NOT_COVERED':'SUCCESS_FACT_COVERED';
 }
 m.automaticSourceReads=replay.automaticSourceReads;m.packetBytes=replay.packetBytes;m.necessaryFactCovered=a.necessaryFacts.every(f=>replay.pack.sources.some(s=>s.path===f.path&&s.startLine<=f.startLine&&s.endLine>=f.endLine));m.modelExposure=false;
}
await save('metrics.json',metrics);await save('funnel.json',metrics.map(m=>({id:m.id,targets:m.targets})));
console.log(JSON.stringify(metrics.map(m=>({id:m.id,selected:m.targetCandidateSelected,sourceRead:m.targets.every(t=>t.sourceRead),factCovered:m.necessaryFactCovered,stages:m.targets.map(t=>t.failureStage),ranges:m.targets.map(t=>t.sourceRange)}))));
