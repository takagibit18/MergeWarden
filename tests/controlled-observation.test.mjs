import test from 'node:test';
import assert from 'node:assert/strict';
import {observeResponse,usageSummary,blockerReasons,errorDetails,reconcileRequests} from '../eval/controlled-e2e/observe.mjs';
test('prepared but aborted requests are distinct from mismatched HTTP payloads',()=>{
 const audits=[{ordinal:1,sha256:'one'},{ordinal:2,sha256:'two',parameters:{max_tokens:31311}}];
 const result=reconcileRequests(audits,['one']);assert.equal(result.matches,true);assert.equal(result.sent,1);assert.equal(result.prepared,2);assert.equal(result.preparedNotSent[0].parameters.max_tokens,31311);
 assert.equal(reconcileRequests(audits,['modified']).matches,false);assert.equal(reconcileRequests([] ,['one']).matches,false);
});
test('transport cause codes survive while nested credentials remain redacted',()=>{
 const error=new TypeError('fetch failed',{cause:Object.assign(new Error('fixture-secret denied'),{code:'EACCES'})});
 const details=errorDetails(error,s=>String(s).replaceAll('fixture-secret','[REDACTED]'));
 assert.equal(details.cause.code,'EACCES');assert.equal(details.cause.message,'[REDACTED] denied');assert(!JSON.stringify(details).includes('fixture-secret'));
});
test('fragmented UTF-8 SSE retains native bytes, clocks, final usage and DONE',async()=>{
 const text='data: '+JSON.stringify({choices:[{delta:{reasoning_content:'判断'}}]})+'\r\n\r\ndata:'+JSON.stringify({choices:[{delta:{tool_calls:[{function:{name:'read_source',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:12,completion_tokens:8,completion_tokens_details:{reasoning_tokens:6}}})+'\n\ndata: [DONE]\n\n';
 const bytes=new TextEncoder().encode(text);let i=0,clock=0;
 const response=new Response(new ReadableStream({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,i+=1));}}));
 const r=await observeResponse(response,{ordinal:1,now:()=>++clock,requestStartedMs:0});
 assert.equal(r.body,text);assert.equal(r.parseErrors,0);assert.equal(r.reasoningChars,2);assert.equal(r.firstReasoningMs,1);assert.equal(r.firstToolDeltaMs,2);assert.equal(r.sawDone,true);assert.equal(r.streamComplete,true);
 const u=usageSummary([r],1);assert.equal(u.complete,true);assert.equal(u.inputTokens,12);assert.equal(u.outputTokens,8);assert.equal(u.reasoningTokens,6);
});
test('interrupted responses and failed fetches do not become zero token totals',async()=>{
 let n=0;const r=await observeResponse(new Response(new ReadableStream({pull(c){if(n++===0)c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"partial"}}]}\n\n'));else c.error(Error('connection lost'));}})),{ordinal:1,now:()=>0,requestStartedMs:0});
 assert.equal(r.streamComplete,false);assert.match(r.streamError,/connection lost/);assert.equal(r.body.includes('partial'),true);
 const u=usageSummary([r],2);assert.equal(u.complete,false);assert.equal(u.outputTokens,null);assert.equal(u.requestsMissingUsage,2);assert.equal(u.knownOutputTokens,0);
});
test('a closed but malformed stream and observation cancellation are visible',async()=>{
 const r=await observeResponse(new Response('data: {bad}\n\n'),{ordinal:1,now:()=>0,requestStartedMs:0});assert.equal(r.parseErrors,1);assert.equal(r.sawDone,false);
 const abort=new AbortController(),pending=observeResponse(new Response(new ReadableStream()),{ordinal:2,now:()=>0,requestStartedMs:0,signal:abort.signal});abort.abort();assert.equal((await pending).streamComplete,false);
});
test('mechanical failure precedence is symmetric across text and graph arms',()=>{
 for(const arm of ['A','B']){const b=blockerReasons({arm,error:null,transport:[{status:500}],responses:[],pack:{},manifest:{metrics:{dispatch:{packagesDelivered:1}}},auditMatches:true});assert.deepEqual(b,['transport_error']);}
 assert.deepEqual(blockerReasons({arm:'B',pack:null,auditMatches:false}),['context_not_delivered','request_audit_mismatch']);
});
