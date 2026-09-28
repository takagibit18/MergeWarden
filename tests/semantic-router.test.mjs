import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDecision} from '../eval/semantic-router/parse.mjs';
import {SYSTEM_PROMPT,userPrompt} from '../eval/semantic-router/prompt.mjs';
import {projectInput,sha} from '../eval/semantic-router/input.mjs';
import {SemanticRouteRuntime} from '../eval/semantic-router/runtime.mjs';
import {MODEL_CONFIG} from '../eval/semantic-router/contracts.mjs';
import {scorePrimary} from '../eval/semantic-router/scoring.mjs';
const input={caseId:'R01',snapshotId:'s',preRouteContext:{changedPaths:['a.py'],diff:[],observed:[]},deterministicOutcome:{outcome:'NO_ROUTE'}};
test('semantic route parser accepts exactly three strict decision enums',()=>{for(const decision of ['ESCALATE','NO_ESCALATION','UNCERTAIN'])assert.equal(parseDecision(JSON.stringify({decision,rationale:'Visible reason'})).decision,decision);assert.equal(parseDecision('{"decision":"escalate","rationale":"why"}').status,'FORMAT_FAILURE');});
test('semantic route parser rejects malformed JSON, missing fields, whitespace rationale and extras',()=>{for(const raw of ['invalid','```json\n{}\n```','{}','{"rationale":"x"}','{"decision":"ESCALATE","rationale":" "}','{"decision":"ESCALATE","rationale":"x","confidence":1}','[]'])assert.equal(parseDecision(raw).status,'FORMAT_FAILURE');});
test('semantic route parser rejects duplicate and escaped duplicate decisions without rejecting rationale words',()=>{
  assert.equal(parseDecision('{"decision":"ESCALATE","decision":"NO_ESCALATION","rationale":"x"}').status,'FORMAT_FAILURE');
  assert.equal(parseDecision('{"decision":"ESCALATE","decis\\u0069on":"NO_ESCALATION","rationale":"x"}').status,'FORMAT_FAILURE');
  assert.equal(parseDecision(JSON.stringify({decision:'UNCERTAIN',rationale:'The text "decision": means nothing here.'})).status,'VALID');
});
test('semantic prompt and input identity are deterministic and retain template-shaped source as data',()=>{
  const x=structuredClone(input);x.preRouteContext.diff=['{observations_json}'];assert.equal(userPrompt(x),userPrompt(structuredClone(x)));assert.equal(sha(x),sha(structuredClone(x)));assert.notEqual(sha(x),sha(input));assert.ok(userPrompt(x).includes('{observations_json}'));assert.match(SYSTEM_PROMPT,/untrusted evidence/);
});
test('semantic input projection excludes private provenance and untouched source snippets',()=>{
  const prefix={caseId:'original',snapshotId:'s',changedPaths:['a.py'],observations:[{ordinal:1,toolName:'search_text',input:{query:'helper'},result:{snapshotId:'s',items:[{path:'b.py',line:4,text:'SECRET_SOURCE'}]},provenance:{privateLabel:'bad'}}]};
  const replay={caseId:'original',routeTriggered:false,checkpoints:[{ordinal:1,state:'IDLE'}],routeHistory:[],highSignals:[],weakSignals:[]};
  const projected=projectInput('R01',prefix,replay);assert.doesNotMatch(JSON.stringify(projected),/SECRET_SOURCE|original|privateLabel/);assert.equal(projected.preRouteContext.observed[0].result.items[0].path,'b.py');
  assert.throws(()=>projectInput('R01',{...prefix,observations:[{...prefix.observations[0],toolName:'read_source',result:{snapshotId:'s',path:'b.py'}}]},replay),/Untouched/);
  assert.throws(()=>projectInput('R01',{...prefix,observations:[{...prefix.observations[0],toolName:'traverse_graph'}]},replay));
});
test('semantic runtime uses existing BigModel adapter once, no tools, frozen sampling and memory-only credential',async()=>{
  const key='fixture-semantic-secret',runtime=await SemanticRouteRuntime.create(MODEL_CONFIG,{MERGEWARDEN_API_KEY:key});let calls=0;
  const result=await runtime.decide(input,{fetch:async(url,init)=>{calls++;const req=new Request(url,init),body=await req.json();assert.equal(req.headers.get('authorization'),'Bearer '+key);assert.equal(body.reasoning_effort,'low');assert.equal(body.temperature,0);assert.equal(body.top_p,1);assert.equal(body.tools,undefined);assert.equal(body.messages.length,2);assert.equal(body.model,'glm-5.3-flash');assert.deepEqual(body.thinking,{type:'enabled',clear_thinking:false});
    const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{content:'{"decision":"UNCERTAIN","rationale":"Need context"}'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}};
    return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.equal(calls,1);assert.equal(result.parsed.decision,'UNCERTAIN');assert.equal(result.requests,1);assert.equal(result.usage.totalTokens,30);assert.equal(result.toolsExposed,0);assert.doesNotMatch(JSON.stringify({runtime,result,config:MODEL_CONFIG}),new RegExp(key));
});
test('semantic runtime does not retry retryable provider failure or serialize credential in its error',async()=>{
  const key='fixture-error-secret',runtime=await SemanticRouteRuntime.create(MODEL_CONFIG,{MERGEWARDEN_API_KEY:key});let calls=0;
  const result=await runtime.decide(input,{fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:key}}),{status:429,headers:{'Content-Type':'application/json'}});}});
  assert.equal(calls,1);assert.equal(result.parsed.status,'PROVIDER_FAILURE');assert.equal(result.usage,null);assert.doesNotMatch(JSON.stringify(result),new RegExp(key));
});
const labels=Array.from({length:7},(_,i)=>({alias:'R0'+(i+1),caseId:'private'+i,label:i<2?'SHOULD_ESCALATE':'SHOULD_NOT_ESCALATE'}));
const predictions=decisions=>decisions.map((decision,i)=>({caseId:'R0'+(i+1),parsed:{status:'VALID',decision,rationale:'x'}}));
test('semantic primary scoring uses first attempt and exact positive/negative case gate',()=>{
  const p=predictions(['ESCALATE','ESCALATE','NO_ESCALATION','NO_ESCALATION','NO_ESCALATION','NO_ESCALATION','ESCALATE']);const s=scorePrimary(p,labels);assert.equal(s.gate,'PASS');assert.equal(s.confusion.TP,2);assert.equal(s.confusion.FP,1);
  p[0].parsed.decision='NO_ESCALATION';assert.equal(scorePrimary(p,labels).gate,'FAIL');p[0].parsed={status:'FORMAT_FAILURE',decision:null};assert.equal(scorePrimary(p,labels).confusion.FORMAT_FAILURE,1);
});
test('semantic UNCERTAIN never counts as TP or TN; provider errors are inconclusive',()=>{
  const p=predictions(['UNCERTAIN','ESCALATE','UNCERTAIN','NO_ESCALATION','NO_ESCALATION','NO_ESCALATION','NO_ESCALATION']);const s=scorePrimary(p,labels);assert.equal(s.gate,'FAIL');assert.equal(s.confusion.TP,1);assert.equal(s.confusion.FN,1);assert.equal(s.confusion.TN,4);assert.equal(s.confusion.POSITIVE_UNCERTAIN,1);assert.equal(s.confusion.NEGATIVE_UNCERTAIN,1);
  p[0].parsed={status:'PROVIDER_FAILURE',decision:null};assert.equal(scorePrimary(p,labels).gate,'INCONCLUSIVE');
});
