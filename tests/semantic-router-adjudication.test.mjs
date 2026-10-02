import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicatePrimary} from '../eval/semantic-router-adjudication.mjs';
const labels=Array.from({length:7},(_,i)=>({alias:String(i),label:i<2?'SHOULD_ESCALATE':'SHOULD_NOT_ESCALATE'}));
const good=(caseId,decision)=>({caseId,parsed:{status:'VALID',decision,rationale:'visible'},rawText:JSON.stringify({decision,rationale:'visible'})});
test('post-freeze audit preserves timeout and invalid JSON while recognizing four decisive false escalations',()=>{
  const rows=labels.map(l=>good(l.alias,'ESCALATE'));rows[2]={caseId:'2',parsed:{status:'PROVIDER_FAILURE',decision:null,rationale:null},rawText:'{"decision":"ESCALATE"'};
  const before=JSON.stringify(rows),r=adjudicatePrimary(rows,labels);assert.equal(r.automatedCompletenessGate,'INCONCLUSIVE');assert.equal(r.gate,'FAIL');assert.equal(r.maxNegativeCorrect,1);assert.equal(r.confusion.FP,4);assert.equal(r.confusion.FORMAT_FAILURE,1);assert.equal(r.confusion.PROVIDER_FAILURE,1);assert.equal(JSON.stringify(rows),before);
});
test('post-freeze audit never claims a quality failure or promotion from unavailable provider results',()=>{
  const unavailable=labels.map(l=>({caseId:l.alias,parsed:{status:'PROVIDER_FAILURE',decision:null,rationale:null},rawText:''}));assert.equal(adjudicatePrimary(unavailable,labels).gate,'INCONCLUSIVE');
  const rows=labels.map((l,i)=>good(l.alias,i<2?'ESCALATE':'NO_ESCALATION'));rows[2]=unavailable[2];const r=adjudicatePrimary(rows,labels);assert.equal(r.gate,'INCONCLUSIVE');assert.equal(r.confusion.TN,4);assert.equal(r.confusion.FORMAT_FAILURE,0);
});
