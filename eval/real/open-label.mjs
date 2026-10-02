import {sha256} from '../../src/infrastructure/files.ts';

export const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b,'en'))):v);
export const digest=value=>sha256(canonical(value));
const ratio=(n,d)=>d?n/d:null;
/** Produce a reviewer packet with no arm, run key, tool metrics, or trace. The
 * private key stays with the experiment operator and restores scoring identity. */
export function buildBlindAdjudication({runs,gold}) {
 const goldById=new Map(gold.map(x=>[x.id,x]));if(goldById.size!==gold.length)throw Error('Duplicate gold task');
 const entries=[],mappings=[];
 for(const run of runs){const reference=goldById.get(run.caseId);if(!reference)throw Error('Missing gold task');
  for(const prediction of run.findings){const itemId='blind-'+digest({runKey:run.runKey,predictionId:prediction.id,predictionSha256:digest(prediction),goldSha256:digest(reference)}).slice(0,16);
   entries.push({itemId,source:{repository:run.task?.repository??null,baseSha:run.task?.base_sha??null,reviewedSha:run.task?.reviewed_sha??null,evidence:prediction.evidence},prediction,hiddenReference:{label:reference.label,goldenFindings:reference.goldenFindings}});
   mappings.push({itemId,runKey:run.runKey,predictionId:prediction.id,predictionSha256:digest(prediction),goldSha256:digest(reference)});
  }
 }
 entries.sort((a,b)=>a.itemId.localeCompare(b.itemId,'en'));mappings.sort((a,b)=>a.itemId.localeCompare(b.itemId,'en'));
 const packet={schemaVersion:1,kind:'blind-real-pr-adjudication',reviewerVisibleFields:['anonymous prediction','source identity/evidence','hidden reference evidence','fix evidence'],entries};
 const packetSha256=digest(packet);return {packet:{...packet,packetSha256},key:{schemaVersion:1,kind:'blind-real-pr-adjudication-key',packetSha256,mappings}};
}
export function unblindAdjudications({judgments,key}) {
 if(judgments.packetSha256!==key.packetSha256||!Array.isArray(judgments.entries)||!Array.isArray(key.mappings))throw Error('Blind adjudication packet drift');
 const byId=new Map(key.mappings.map(x=>[x.itemId,x]));if(byId.size!==key.mappings.length)throw Error('Duplicate blind mapping');const seen=new Set();
 return judgments.entries.map(j=>{const mapping=byId.get(j.itemId);if(!mapping||seen.has(j.itemId))throw Error('Unknown or duplicate blind item');seen.add(j.itemId);const {itemId,...decision}=j;return {...decision,...mapping,blindPacketSha256:key.packetSha256};});
}
/** No automatic semantic matches. Adjudication is a separate, hash-bound receipt.
 * Duplicates are redundant reports, excluded from precision rather than counted as
 * new true positives. Unknown predictions remain unknown, including in clean PRs.
 */
export function scoreOpenLabel({runs,gold,adjudications=[]}) {
 const goldById=new Map(gold.map(x=>[x.id,x]));
 if(goldById.size!==gold.length)throw Error('Duplicate gold task');
 const receipts=new Map();
 for(const a of adjudications){const k=a.runKey+'/'+a.predictionId;if(receipts.has(k))throw Error('Duplicate adjudication');receipts.set(k,a);}
 const seenRuns=new Set(),usedReceipts=new Set(),cases=[];
 const totals={referenceFindings:0,matchedReferenceFindings:0,defectPRs:0,matchedDefectPRs:0,matchedPredictions:0,newValid:0,duplicates:0,confirmedFP:0,unadjudicated:0,completed:0};
 for(const run of runs){
  if(seenRuns.has(run.runKey))throw Error('Score one selected attempt per run key; do not silently pool retries');seenRuns.add(run.runKey);
  const g=goldById.get(run.caseId);if(!g)throw Error('Missing gold task');
  const refs=new Set(g.goldenFindings.map(f=>f.id)),matched=new Set(),explicitMatches=new Set(),predIds=new Set(),mapping=[];
  if(refs.size!==g.goldenFindings.length)throw Error('Duplicate gold finding');
  totals.referenceFindings+=refs.size;if(g.label==='defect')totals.defectPRs++;
  if(run.status==='completed'&&run.delivered)totals.completed++;
  for(const prediction of run.findings){
   if(predIds.has(prediction.id))throw Error('Duplicate prediction ID');predIds.add(prediction.id);
   const key=run.runKey+'/'+prediction.id,a=receipts.get(key);
   let status='unadjudicated',goldenId=null,rationale='No adjudication receipt';
   if(a){
    usedReceipts.add(key);
    if(a.predictionSha256!==digest(prediction)||a.goldSha256!==digest(g))throw Error('Adjudication content drift');
    if(!['matched','new_valid','duplicate','false_positive','unadjudicated'].includes(a.status))throw Error('Unknown adjudication status');
    if(!a.reviewer?.name||!['human','agent'].includes(a.reviewer.kind)||!a.rationale?.trim())throw Error('Adjudication needs reviewer and reasoning');
    status=a.status;goldenId=a.goldenId??null;rationale=a.rationale;
    if(['matched','duplicate'].includes(status)&&!refs.has(goldenId))throw Error('Unknown reference finding');
    if(!['matched','duplicate'].includes(status)&&goldenId!==null)throw Error('Non-reference judgment must not name gold');
    if(status==='matched'&&explicitMatches.has(goldenId))throw Error('Repeated underlying finding must be adjudicated duplicate');
    if(status==='new_valid'&&(!a.introductionEvidence||!a.sourceEvidence))throw Error('New valid needs source and introduction evidence');
   }
   if(status==='matched'){matched.add(goldenId);explicitMatches.add(goldenId);totals.matchedPredictions++;}
   if(status==='duplicate'){matched.add(goldenId);totals.duplicates++;}
   if(status==='new_valid')totals.newValid++;
   if(status==='false_positive')totals.confirmedFP++;
   if(status==='unadjudicated')totals.unadjudicated++;
   mapping.push({predictionId:prediction.id,predictionSha256:digest(prediction),status,goldenId,rationale});
  }
  totals.matchedReferenceFindings+=matched.size;if(g.label==='defect'&&matched.size)totals.matchedDefectPRs++;
  cases.push({runKey:run.runKey,caseId:run.caseId,status:run.status,mapping,matchedReferenceIds:[...matched].sort(),missedReferenceIds:[...refs].filter(x=>!matched.has(x))});
 }
 if(usedReceipts.size!==receipts.size)throw Error('Orphan adjudication');
 // A semantic duplicate of gold still discovers that issue, even when no
 // prediction has the exact reference location/wording. Count the cluster once.
 const valid=totals.matchedReferenceFindings+totals.newValid,known=valid+totals.confirmedFP,all=known+totals.unadjudicated;
 return {schemaVersion:1,kind:'open-label-real-pr',duplicatePolicy:'Exclude redundant predictions from precision; count each reference once per run.',totals,referenceFindingRecall:ratio(totals.matchedReferenceFindings,totals.referenceFindings),referencePRRecall:ratio(totals.matchedDefectPRs,totals.defectPRs),adjudicatedPrecision:ratio(valid,known),precisionInterval:{lower:ratio(valid,all),upper:ratio(valid+totals.unadjudicated,all)},completeDeliveryRate:ratio(totals.completed,runs.length),cases};
}
