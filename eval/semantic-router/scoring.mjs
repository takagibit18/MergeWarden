import assert from 'node:assert/strict';
export function scorePrimary(predictions,labels){
  assert.equal(new Set(predictions.map(p=>p.caseId)).size,predictions.length);assert.equal(predictions.length,labels.length);
  const confusion={TP:0,FN:0,TN:0,FP:0,POSITIVE_UNCERTAIN:0,NEGATIVE_UNCERTAIN:0,FORMAT_FAILURE:0,PROVIDER_FAILURE:0,LABEL_UNCERTAIN:0};
  const cases=predictions.map(p=>{const l=labels.find(l=>l.alias===p.caseId);assert.ok(l);const {status,decision}=p.parsed;let outcome;
    if(status==='FORMAT_FAILURE')confusion.FORMAT_FAILURE++;if(status==='PROVIDER_FAILURE')confusion.PROVIDER_FAILURE++;
    if(l.label==='SHOULD_ESCALATE'){if(status==='VALID'&&decision==='ESCALATE'){outcome='TP';confusion.TP++;}else{outcome='FN';confusion.FN++;if(decision==='UNCERTAIN')confusion.POSITIVE_UNCERTAIN++;}}
    else if(l.label==='SHOULD_NOT_ESCALATE'){if(status==='VALID'&&decision==='NO_ESCALATION'){outcome='TN';confusion.TN++;}else if(status==='VALID'&&decision==='ESCALATE'){outcome='FP';confusion.FP++;}else if(decision==='UNCERTAIN'){outcome='NEGATIVE_UNCERTAIN';confusion.NEGATIVE_UNCERTAIN++;}else outcome=status;}
    else{outcome='LABEL_UNCERTAIN';confusion.LABEL_UNCERTAIN++;}
    return {alias:p.caseId,sourceCaseId:l.caseId,label:l.label,decision,status,outcome,rationale:p.parsed.rationale};
  });
  const positiveCount=labels.filter(l=>l.label==='SHOULD_ESCALATE').length,negativeCount=labels.filter(l=>l.label==='SHOULD_NOT_ESCALATE').length;
  const eligible=predictions.length===7&&positiveCount===2&&negativeCount===5;
  const pass=eligible&&confusion.TP===2&&confusion.TN>=4&&confusion.FP<=1&&confusion.FORMAT_FAILURE===0&&confusion.PROVIDER_FAILURE===0;
  return {cases,confusion,positiveCount,negativeCount,gate:confusion.PROVIDER_FAILURE||!eligible?'INCONCLUSIVE':pass?'PASS':'FAIL',capability:confusion.PROVIDER_FAILURE||!eligible?'EXPERIMENT INCONCLUSIVE':pass?'SEMANTIC ROUTER CAPABILITY = PROMISING':'SEMANTIC ROUTER CAPABILITY NOT PROVEN'};
}
