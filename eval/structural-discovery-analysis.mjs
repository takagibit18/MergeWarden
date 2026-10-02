/** Post-run accounting is separate from the immutable evidence validator. */
export function discoverySummary(run) {
 const observation=run.routingState?.observation??{episodes:{},graphDiscoveredPaths:[],synthesized:[]};
 const discoveries=observation.graphDiscoveredPaths;
 const verified=[...new Map(discoveries.filter(d=>d.sourceCallId!==undefined).map(d=>[JSON.stringify([d.routeId,d.path,d.sourceCallId]),d])).values()];
 const strict=run.trace?.sourceLinks?.filter(l=>l.strictNovel&&verified.some(d=>d.graphCallId===l.traverseCallId&&d.sourceCallId===l.sourceCallId))??[];
 return {episodes:Object.entries(observation.episodes).map(([routeId,stages])=>({routeId,...stages})),discoveries,verified,strict,
   entitySearchToSource:verified.filter(d=>d.discoveryMode==='entity_search'),traversalToSource:verified.filter(d=>d.discoveryMode==='traversal'),synthesized:observation.synthesized};
}
export function discoveryStop(runs) {
 const first=runs.filter(r=>['P1-signature-caller','P2-multihop'].includes(r.caseId)&&['B','C'].includes(r.arm));
 return first.length===4&&first.every(r=>discoverySummary(r).strict.length===0);
}
export function strictEntitySearchEvidence(run,f,source) {
 const trace=run.trace, attribution=trace?.findings?.find(a=>a.predictionId===f.id);
 if(source.discoveryMode!=='entity_search'||trace.traceIssues?.length||!attribution?.submissionCallId)return false;
 const calls=trace.calls??[], submission=calls.find(c=>c.id===attribution.submissionCallId);
 if(!submission||submission.isError||submission.response?.accepted!==true)return false;
 const reads=f.evidence.map(e=>calls.find(c=>c.name==='read_source'&&!c.isError&&c.response?.status==='ok'&&c.resultEvent<submission.callEvent&&['snapshotId','revision','path','startLine','endLine','contentSha256'].every(k=>c.response[k]===e[k])));
 if(!reads.length||!reads.every(Boolean)||!reads.some(c=>c.id===source.sourceCallId))return false;
 const verified=calls.find(c=>c.id===source.sourceCallId);
 const exposes=c=>['read_source','read_diff'].includes(c.name)?c.response?.path===source.path:['search_text','search_entity','traverse_graph'].includes(c.name)&&(c.response?.items??[]).some(e=>e.path===source.path);
 return !calls.some(c=>c.id!==source.graphCallId&&c.id!==source.sourceCallId&&!c.isError&&c.resultEvent<verified.callEvent&&exposes(c));
}
export function analyzeConversion(run,relevance,correctness,positive) {
 const d=discoverySummary(run),findings=run.findings??[];
 const sources=d.verified.filter(s=>relevance.some(l=>l.routeId===s.routeId&&l.path===s.path&&l.sourceCallId===s.sourceCallId&&l.relevant));
 const correct=findings.filter(f=>correctness.some(c=>c.findingId===f.id&&c.correct));
 const bound=(f,s)=>f.evidence.some(e=>e.path===s.path)&&run.trace?.findings?.some(a=>a.predictionId===f.id&&a.sourceCallIds?.includes(s.sourceCallId));
 const assisted=correct.filter(f=>sources.some(s=>bound(f,s)&&(s.discoveryMode==='traversal'?run.trace?.findings?.some(a=>a.predictionId===f.id&&a.discoveryPath==='graph_assisted'&&a.chains?.some(c=>c.sourceCallId===s.sourceCallId)):strictEntitySearchEvidence(run,f,s))));
 const episodes=d.episodes.map(e=>{
   const relevant=sources.filter(s=>s.routeId===e.routeId);
   const using=findings.filter(f=>relevant.some(s=>bound(f,s)));
   const right=assisted.filter(f=>relevant.some(s=>bound(f,s)));
   const synthesized=d.synthesized.some(key=>JSON.parse(key)[0]===e.routeId);
   const invalid=findings.filter(f=>correctness.some(c=>c.findingId===f.id&&!c.correct));
   // Broad safety count: invalid final findings after a novel-source route, regardless of claimed evidence.
   const falseConversion=!positive&&e.R4&&invalid.length>0;
   return {...e,R5:relevant.length>0,R6:using.length>0,R7:right.length>0,RF:falseConversion,
     synthesisFalseConversion:falseConversion&&synthesized,correctGraphAssisted:right.map(f=>f.id),
     missedConversion:positive&&relevant.length>0&&correct.length===0,
     unattributedConversion:positive&&relevant.length>0&&correct.length>0&&right.length===0};
 });
 let stage;
 if(assisted.length)stage='SUCCESS';
 else if(!run.manifest?.metrics?.routing?.activated)stage='F0';
 else if(!episodes.some(e=>e.R1))stage='F1';
 else if(sources.length)stage=correct.length?'ATTRIBUTION_GAP':findings.length?'F6':'F5';
 else if(d.verified.length)stage='F4';
 else if(!episodes.some(e=>e.R2))stage='F2';
 else stage='F3';
 return {episodes,stage,sourceCount:sources.length,findingCount:findings.length,usesNovelEvidence:findings.some(f=>d.verified.some(s=>bound(f,s))),correctCount:correct.length,correctGraphAssisted:assisted.length,missedConversion:episodes.some(e=>e.missedConversion),falseConversion:episodes.some(e=>e.RF),synthesisFalseConversion:episodes.some(e=>e.synthesisFalseConversion),attributionGap:episodes.some(e=>e.unattributedConversion)};
}
