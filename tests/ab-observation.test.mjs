import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRequests,shouldPause} from '../eval/real/ab-observation.mjs';
import {resumeLimit} from '../eval/real/ab-checkpoint.mjs';
import {digest} from '../eval/real/open-label.mjs';
const request=ordinal=>({type:'custom',customType:'mergewarden.provider-request.v1',data:{ordinal}});
const answer=(stopReason='stop',totalTokens=2,errorMessage)=>({type:'message',message:{role:'assistant',stopReason,usage:{totalTokens},errorMessage}});
test('local synthetic cancellation after all replies is not a provider failure or usage gap',()=>{
 const r=classifyRequests([request(1),answer(),request(2),answer('toolUse'),answer('error',0,'This operation was aborted')],{termination:{reason:'tool_budget'}});
 assert.equal(r.requests,2);assert.equal(r.providerErrors,0);assert.equal(r.localCancellationMessages,1);assert.equal(r.usageComplete,true);
 assert(shouldPause({status:'partial',delivered:true,observation:{mechanicalBlocker:false}}));
});
test('an interrupted actual request keeps missing usage, independent of local cancellation',()=>{
 const r=classifyRequests([request(1),answer(),request(2),answer('error',0,'This operation was aborted')],{termination:{reason:'time_budget'}});
 assert.equal(r.providerErrors,0);assert.equal(r.interruptedRequests,1);assert.equal(r.usageComplete,false);assert.deepEqual(r.requestsMissingUsage,[2]);
});
test('real provider errors, missing responses, and unmatched records cannot be masked by closeout',()=>{
 const r=classifyRequests([request(1),answer('error',0,'429 unavailable'),request(2)],{termination:{reason:'tool_budget'}});
 assert.equal(r.providerErrors,1);assert.equal(r.usageComplete,false);assert.deepEqual(r.requestsMissingUsage,[1,2]);
 assert.equal(classifyRequests([request(1),answer(),answer('error',0,'unexpected')],{termination:{reason:'tool_budget'}}).unmatchedAssistantMessages,1);
 assert.equal(classifyRequests([request(2),answer()]).requestOrderValid,false);
});
test('early reviewed interruption still stops at 20 records and later continuation binds all reviewed records',()=>{
 const experiment={experimentSha256:'locked',checkpointPairs:10,plan:Array(80)},runs=Array.from({length:7},(_,i)=>({i}));
 const review={decision:'CONTINUE',experimentSha256:'locked',reviewedRuns:7,observedRunsSha256:digest(runs)};
 assert.equal(resumeLimit(experiment,runs,review),20);assert.throws(()=>resumeLimit(experiment,runs,{...review,decision:'HOLD'}));
 assert.throws(()=>resumeLimit(experiment,[...runs,{i:7}],review));const twenty=Array.from({length:20},(_,i)=>({i}));
 assert.equal(resumeLimit(experiment,twenty,{...review,reviewedRuns:20,observedRunsSha256:digest(twenty)}),80);
});
