import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {scoreOpenLabel,digest} from '../real/open-label.mjs';
import {writeJson} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),read=async p=>JSON.parse(await readFile(p,'utf8'));
const references=(await readFile(join(root,'corpus/private/gold.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const gold=references.map(r=>({id:r.id,label:r.label,goldenFindings:r.label==='defect'?[{id:'ref-'+r.id,claim:r.rationale,evidence:r.evidence}]:[],referenceVersion:'static-20260929',humanReviewed:false,seen_in_prior_dev:true}));
const raw=await Promise.all((await readdir(join(root,'execution/reviews'))).filter(n=>n.endsWith('.json')).map(n=>read(join(root,'execution/reviews',n))));
const runs=raw.filter(r=>r.phase==='pilot').map(r=>({...r,runKey:r.caseId+'/'+r.arm,delivered:r.manifest?.status==='delivered',findings:r.report?.findings??[]}));
let verified=[];try{verified=(await read(join(root,'evaluation/adjudication/verified.json'))).entries;}catch(e){if(e.code!=='ENOENT')throw e;}
const receipts=verified.map(j=>{const r=runs.find(r=>r.runId===j.runId),p=r.findings.find(f=>f.id===j.findingId),g=gold.find(g=>g.id===r.caseId);return {...j,runKey:r.runKey,predictionId:p.id,status:j.classification,goldenId:['matched','duplicate'].includes(j.classification)?'ref-'+r.caseId:null,predictionSha256:digest(p),goldSha256:digest(g),reviewer:{name:'Codex static verification of blinded same-model proposal',kind:'agent'}};});
const scores={scope:'Operational pilot, excluded from formal quality claims',referenceVersion:'static-20260929',receiptPolicy:'No automatic acceptance of model proposals',arms:{},pairedCases:[]};
for(const arm of ['A','B','C']){const selected=runs.filter(r=>r.arm===arm),keys=new Set(selected.map(r=>r.runKey));const score=scoreOpenLabel({runs:selected,gold,adjudications:receipts.filter(j=>keys.has(j.runKey))});const clean=selected.filter(r=>gold.find(g=>g.id===r.caseId).label==='clean'),complete=clean.filter(r=>r.status==='completed'&&r.delivered),fps=new Set(receipts.filter(j=>keys.has(j.runKey)&&j.status==='false_positive').map(j=>j.runKey));scores.arms[arm]={...score,planned:4,notStarted:4-selected.length,clean:{planned:2,started:clean.length,completed:complete.length,confirmedFalsePositivePRs:complete.filter(r=>fps.has(r.runKey)).length,rate:complete.length?complete.filter(r=>fps.has(r.runKey)).length/complete.length:null,unknownFindingPRs:complete.filter(r=>score.cases.find(c=>c.runKey===r.runKey).mapping.some(m=>m.status==='unadjudicated')).length}};}
for(const id of new Set(runs.map(r=>r.caseId)))if(['A','B','C'].every(a=>runs.some(r=>r.caseId===id&&r.arm===a&&r.status==='completed'&&r.delivered)))scores.pairedCases.push(id);
await writeJson(join(root,'summary/finding-mapping.json'),receipts);await writeJson(join(root,'summary/pilot-quality.json'),scores);console.log(JSON.stringify(scores));
