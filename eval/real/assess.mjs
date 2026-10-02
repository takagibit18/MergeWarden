import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareSourceScope} from './scope.mjs';
import {isolatedState,writeJson,sha256} from '../../src/infrastructure/files.ts';
const args=process.argv.slice(2),get=k=>{const n=args.indexOf(k);return n<0?undefined:args[n+1];};
if(!get('--candidates')||!get('--probe')||!get('--output'))throw Error('Use --candidates HYDRATED_JSONL --probe PROBE_RESULT_JSON --output OUTSIDE_CHECKOUT');
const bytes=await readFile(resolve(get('--candidates')),'utf8');
const candidates=bytes.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
const probe=JSON.parse(await readFile(resolve(get('--probe')),'utf8'));
const sdkProbe=get('--sdk-probe')?JSON.parse(await readFile(resolve(get('--sdk-probe')),'utf8')):probe;
const checked=[];
for(const p of probe.cases) {
 const matches=candidates.filter(c=>c.repository===p.repository&&c.base_sha===p.baseSha&&(c.reviewed_sha===p.headSha||c.allowed_reviewed_sha_candidates?.includes(p.headSha)));
 if(matches.length!==1)throw Error('Probe must bind to one original source row');
 const sdk=sdkProbe.cases.find(c=>c.caseId===p.caseId);
 if(sdk?.runs.length&&(sdk.snapshotId!==p.snapshotId||sdk.baseSha!==p.baseSha||sdk.headSha!==p.headSha))throw Error('SDK probe snapshot drift');
 const c=matches[0];checked.push({caseId:p.caseId,candidateId:c.candidate_id,sourceRowSha256:c.source_row_sha256,baseSha:p.baseSha,reviewedSha:p.headSha,snapshotId:p.snapshotId??null,scope:p.changedPaths?compareSourceScope(c,p.headSha,p.changedPaths):{status:'snapshot_failed'},minimumToolsIncludingSubmit:p.minimumToolsIncludingSubmit??null,scriptedRuns:(sdk?.runs??[]).map(r=>({arm:r.arm,status:r.status,tools:r.trace.metrics.toolCalls,latencyMs:r.latencyMs,metrics:r.manifest.metrics}))});
}
const screening=JSON.parse(await readFile(new URL('./manifests/screening.json',import.meta.url)));
for(const r of screening.records)if(!candidates.some(c=>c.candidate_id===r.candidate_id&&c.source_row_sha256===r.source_row_sha256))throw Error('Screening/source binding mismatch');
const excluded=screening.records.filter(r=>r.decision==='exclude_supplied_reference').length;
const result={schemaVersion:1,candidateBytesSha256:sha256(bytes),readyForFormalAB:false,paidModelCalls:0,projectCodeExecuted:false,
 counts:{candidates:candidates.length,positiveCandidates:candidates.filter(c=>c.source_role==='positive_candidate').length,sourceCleanCandidates:candidates.filter(c=>c.source_role==='negative_candidate').length,excludedPositiveReferences:excluded,fullyAuditedScoringCases:0},
 blockers:['Positive pool contains fewer than 24 supported functional reference claims after source-comment screening; no replacement sampling performed.',
 'No final 24/16 tasks/gold/audit lock has been admitted. Source-clean labels do not prove absence; actual base-to-head scope requires re-audit.',
 'Real-corpus entry currently provides static/SDK preflight only; legacy live runners consume controlled fixture cases. A real-corpus live/adjudication path remains necessary.',
 'Legacy closed-gold scoring treats unmatched predictions as false positives. Real corpus needs new_valid, duplicate and unadjudicated handling before quality scoring.',
 'No real-model pilot or unified live budget has been frozen. Offline scripted timings/tokens are not model cost estimates.'],
 checks:checked,interpretation:'Pilot engineering checks only; no quality measurement or human annotation. Unmodified upstream commit pairs retained even when source review scope differs.'};
const out=await isolatedState(resolve(get('--output')),fileURLToPath(new URL('../../',import.meta.url)));
await writeJson(join(out,'readiness.json'),result);console.log(JSON.stringify({output:out,readyForFormalAB:false,counts:result.counts}));
