import assert from 'node:assert/strict';
export const UTILITY_VERSION='graph-vs-text-route-utility-1';
export function containsFact(pages,fact){return pages.some(p=>p.path===fact.path&&p.startLine<=fact.startLine&&p.endLine>=fact.endLine);}
export function adjudicate(e){
 let label='UNCERTAIN',confidence='LOW',reason='Insufficient comparative evidence';
 if(e.toolMismatch===true){label='NO_ESCALATION';confidence='MEDIUM';reason='TOOL_MISMATCH: graph does not represent the required contract';}
 else if(e.decisionRelevant===false){label='NO_ESCALATION';confidence='MEDIUM';reason='No specific additional structural evidence with substantial decision value established';}
 else if(e.decisionRelevant===true&&e.textRelevant===true&&e.graphAdvantage!==true){label='TEXT_FIRST';confidence='MEDIUM';reason='Frozen text arm delivered sufficient decision-relevant context; no established graph advantage';}
 else if(e.decisionRelevant===true&&e.graphDelivered===true&&e.textRelevant===false){label='GRAPH_ESCALATE';confidence='MEDIUM';reason='Graph-exclusive delivery versus this deterministic text comparator, not versus all text investigation';}
 else if(e.decisionRelevant===true&&e.graphDelivered===true&&e.graphAdvantage===true){label='GRAPH_ESCALATE';confidence='MEDIUM';reason='Both arms evaluated; specific incremental completeness/reliability evidence recorded';}
 else if(e.graphOpportunity===true&&!e.graphDelivered){reason='GRAPH_DISCOVERY_VALUE_PRESENT; DELIVERY_NOT_ESTABLISHED';}
 return {label,confidence,reason,action:{GRAPH_ESCALATE:'ESCALATE',TEXT_FIRST:'NO_ESCALATION',NO_ESCALATION:'NO_ESCALATION',UNCERTAIN:'UNCERTAIN'}[label]};
}
export function boundaryGate(rows){
 const clear=rows.filter(r=>r.label!=='UNCERTAIN'&&['HIGH','MEDIUM'].includes(r.confidence)),graph=clear.filter(r=>r.label==='GRAPH_ESCALATE').length,nonGraph=clear.length-graph,uncertain=rows.length-clear.length;
 return {pass:graph>=2&&nonGraph>=3&&clear.length>=5&&uncertain<=rows.length/2,clearGraph:graph,clearNonGraph:nonGraph,clearTotal:clear.length,uncertain,total:rows.length};
}
export function exploratoryScore(labels,decisions){
 const matrix={TP:0,FP:0,TN:0,FN:0,FORMAT_OR_TRANSPORT_FAILURE:0,POSITIVE_UNCERTAIN:0,NEGATIVE_UNCERTAIN:0},rows=[];
 for(const l of labels){const d=decisions.find(d=>d.caseId===l.caseId);assert(d);let result;
  if(l.label==='UNCERTAIN'||l.confidence==='LOW')result='EXCLUDED_UNCERTAIN_LABEL';
  else if(!['ESCALATE','NO_ESCALATION','UNCERTAIN'].includes(d.decision)){result='FORMAT_OR_TRANSPORT_FAILURE';matrix[result]++;}
  else if(d.decision==='UNCERTAIN'){result=l.label==='GRAPH_ESCALATE'?'POSITIVE_UNCERTAIN':'NEGATIVE_UNCERTAIN';matrix[result]++;if(l.label==='GRAPH_ESCALATE')matrix.FN++;}
  else {result=l.label==='GRAPH_ESCALATE'?(d.decision==='ESCALATE'?'TP':'FN'):(d.decision==='ESCALATE'?'FP':'TN');matrix[result]++;}
  rows.push({caseId:l.caseId,alias:l.alias,oldLabel:d.oldLabel,oldDecision:d.decision,newUtilityLabel:l.label,confidence:l.confidence,result});
 }
 return {status:'EXPLORATORY_ONLY',oldPrimaryGate:'FAIL_UNCHANGED',oldPromptObjectiveMismatch:true,matrix,rows};
}
