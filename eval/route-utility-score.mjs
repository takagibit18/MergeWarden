import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities} from './candidate-dataset-context.mjs';
import {adjudicate,containsFact,boundaryGate,UTILITY_VERSION} from './route-utility-rubric.mjs';
const out=resolve(process.argv[2]),phase=join(out,'phase-b');
const phaseName=process.argv[3]??'phase-a';assert(/^phase-a(?:-v\d+)?$/.test(phaseName));assert(process.permission);assert.equal(process.permission.has('fs.write',join(out,phaseName)),false);
const freeze=await read(join(out,phaseName,'counterfactual-freeze.json'));await checkIdentities(freeze.files);
const {registrations}=await read(join(out,'universe.json')),notes=await read(join(phase,'adjudication-input.json')),rows=[];
assert.equal(notes.length,registrations.length);assert.equal(new Set(notes.map(n=>n.caseId)).size,notes.length);
for(const c of registrations){
 const n=notes.find(n=>n.caseId===c.caseId);assert(n);assert(n.rationale&&n.questions&&n.facts);
 const t=await read(join(out,phaseName,'text-comparator',c.caseId+'.json')),g=await read(join(out,phaseName,'graph-comparator',c.caseId+'.json'));
 const facts=n.facts.map(f=>({...f,text:containsFact(t.packet.sources,f),graph:containsFact(g.sourcePack.sources,f),reached:containsFact(g.reachedEntities,f),retained:containsFact(g.pool.eligible.map(c=>({path:c.terminalPath,...c.sourceRange})),f)}));
 const all=key=>facts.length?facts.every(f=>f[key]):null;
 const evidence={decisionRelevant:n.decisionRelevant,toolMismatch:n.toolMismatch??false,graphOpportunity:n.graphOpportunity,graphDelivered:all('graph'),graphReached:all('reached'),textRelevant:all('text'),graphAdvantage:false};
 const result=adjudicate(evidence);
 const row={version:UTILITY_VERSION,caseId:c.caseId,alias:c.alias,primary:c.primary,group:c.group,deterministicRouteTriggered:c.deterministicRouteTriggered,oldLabel:n.oldLabel??null,reassessmentSuggestion:n.reassessmentSuggestion??null,...result,evidence,facts,questions:n.questions,rationale:n.rationale,limitations:n.limitations??[],oldAudit:n.oldAudit,opportunityEvidence:n.opportunityEvidence??null,textQueries:t.queries.map(q=>q.query),textDelivered:t.packet.sources.map(s=>({path:s.path,startLine:s.startLine,endLine:s.endLine})),graphDelivered:g.sourcePack.sources.map(s=>({path:s.path,startLine:s.startLine,endLine:s.endLine})),anchorStatus:g.anchorStatus,cost:{text:t.budgetUsed,graph:g.budgetUsed},graphOutcome:g.stopReason};
 if(facts.some(f=>f.text&&f.graph)&&!all('text'))row.partialOverlap=true;
 rows.push(row);await save(join(phase,'case-adjudications',c.caseId+'.json'),row);
}
await save(join(phase,'utility-rubric.json'),{version:UTILITY_VERSION,implementation:await identity(join(import.meta.dirname,'route-utility-rubric.mjs')),rangeScoring:'All explicitly adjudicated core facts must fit whole delivered pages. Text result snippets alone are navigation metadata, not verified source. Raw reach never counts as delivery. Private-selected fact ranges are scoring only.',author:'Single Codex development adjudicator; already exposed to historical study. No independent human/holdout claim.'});
await save(join(phase,'utility-labels.json'),rows);
await save(join(phase,'confidence.json'),rows.map(r=>({caseId:r.caseId,label:r.label,confidence:r.confidence,limitations:r.limitations})));
await save(join(phase,'graph-vs-text-table.json'),rows.map(({caseId,alias,primary,label,confidence,evidence,cost,anchorStatus,textQueries})=>({caseId,alias,primary,label,confidence,evidence,cost,anchorStatus,textQueries})));
const metricsFor=rs=>({cases:rs.length,GraphOpportunityRate:rs.filter(r=>r.evidence.graphOpportunity===true).length/rs.length,GraphOpportunityUnknown:rs.filter(r=>r.evidence.graphOpportunity===null).length,GraphDeliveredRate:rs.filter(r=>r.evidence.graphDelivered===true).length/rs.length,TextRelevantContextRate:rs.filter(r=>r.evidence.textRelevant===true).length/rs.length,GraphExclusiveCount:rs.filter(r=>r.evidence.graphDelivered===true&&r.evidence.textRelevant===false).length,GraphAdvantageCount:0,TextEquivalentCount:rs.filter(r=>r.evidence.textRelevant===true&&r.evidence.decisionRelevant===true).length,NoDecisionValueCount:rs.filter(r=>r.evidence.decisionRelevant===false).length,UncertainCount:rs.filter(r=>r.label==='UNCERTAIN').length,labels:Object.fromEntries(['GRAPH_ESCALATE','TEXT_FIRST','NO_ESCALATION','UNCERTAIN'].map(l=>[l,rs.filter(r=>r.label===l).length])),anchorFailures:rs.filter(r=>r.anchorStatus!=='resolved').length});
await save(join(phase,'metrics.json'),{primary:metricsFor(rows.filter(r=>r.primary)),secondaryOnly:metricsFor(rows.filter(r=>!r.primary)),all:metricsFor(rows),rateNote:'All-case denominators include unknown/unresolved rows; unknown opportunity count reported separately. TextEquivalent = sufficient decision context, not file equality.'});
const primary=boundaryGate(rows.filter(r=>r.primary)),all=boundaryGate(rows),fallback=boundaryGate(rows.filter(r=>!r.deterministicRouteTriggered));
await save(join(phase,'gate.json'),{primary,all,futureNoHardMatchSubset:fallback,status:all.pass?'READY_FOR_REVIEW':'INSUFFICIENT_CLEAR_GRAPH_UTILITY_POSITIVES',oldPrimaryGate:'FAIL_UNCHANGED'});
await save(join(phase,'utility-label-freeze.json'),{identity:UTILITY_VERSION,frozenAt:new Date().toISOString(),beforeHistoricalPredictionRead:true,files:await Promise.all(['adjudication-input.json','utility-labels.json','utility-rubric.json','confidence.json','graph-vs-text-table.json','metrics.json','gate.json'].map(f=>identity(join(phase,f)))),phaseA:await identity(join(out,phaseName,'counterfactual-freeze.json'))});
await checkIdentities(freeze.files);console.log(JSON.stringify({cases:rows.length,primary,all,fallback}));
