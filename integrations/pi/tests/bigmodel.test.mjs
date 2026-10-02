import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRuntime, listModels } from '../src/runtime.ts';

test('BigModel registers only the selected Flash model and keeps credentials in memory', async t => {
  const original = globalThis.fetch; globalThis.fetch = async () => { throw Error('Network forbidden'); }; t.after(() => { globalThis.fetch = original; });
  assert.deepEqual(await listModels('bigmodel'), [{provider:'bigmodel',id:'glm-5.3-flash',name:'GLM-5.3-Flash (BigModel)'}]);
  const runtime = await createModelRuntime('bigmodel','fixture-secret');
  const model = runtime.getModel('bigmodel','glm-5.3-flash');
  assert.equal(model.baseUrl,'https://open.bigmodel.cn/api/paas/v4/');
  assert.equal(runtime.getModel('bigmodel','glm-5.3'),undefined);
  assert.equal((await runtime.getAuth('bigmodel')).auth.apiKey,'fixture-secret');
  assert.doesNotMatch(JSON.stringify(model),/fixture-secret/);
});

test('BigModel uses bearer auth and exact Flash model through the real Pi HTTP adapter', async t => {
  const original = globalThis.fetch; const requests=[];
  globalThis.fetch = async (url, init) => {
    const request = new Request(url,init); const body = await request.json(); requests.push({url:request.url,headers:request.headers,body});
    const delta = requests.length===1 ? {reasoning_content:'Check source.',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'read_source',arguments:'{"path":"app.py"}'}}]} : {content:'Finished.'};
    const finish = requests.length===1 ? 'tool_calls' : 'stop';
    const chunk = {id:'offline',object:'chat.completion.chunk',created:1,model:'glm-5.3-flash',choices:[{index:0,delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const runtime=await createModelRuntime('bigmodel','fixture-secret'); const model=runtime.getModel('bigmodel','glm-5.3-flash');
  const context={systemPrompt:'Read-only review.',messages:[{role:'user',content:'Review.',timestamp:1}],tools:[{name:'read_source',description:'Read frozen source',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]};
  const first=await runtime.completeSimple(model,context,{reasoning:'low',maxTokens:256});
  assert.equal(first.stopReason,'toolUse'); assert.ok(first.content.some(c=>c.type==='toolCall' && c.name==='read_source'));
  const second=await runtime.completeSimple(model,{...context,messages:[...context.messages,first,{role:'toolResult',toolCallId:'call_1',toolName:'read_source',content:[{type:'text',text:'print(1)'}],isError:false,timestamp:2}]},{reasoning:'low',maxTokens:256});
  assert.equal(second.stopReason,'stop');
  for(const r of requests) {
    assert.equal(r.url,'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(r.headers.get('authorization'),'Bearer fixture-secret'); assert.match(r.headers.get('content-type'),/application\/json/);
    assert.equal(r.body.model,'glm-5.3-flash'); assert.equal(r.body.max_tokens,256);
    assert.equal(r.body.store,undefined); assert.equal(r.body.reasoning_effort,'low'); assert.equal(r.body.tool_stream,true);
    assert.deepEqual(r.body.thinking,{type:'enabled',clear_thinking:false}); assert.equal(r.body.messages[0].role,'system');
  }
  const assistant=requests[1].body.messages.find(m=>m.role==='assistant');
  assert.equal(assistant.reasoning_content,'Check source.'); assert.equal(assistant.tool_calls[0].id,'call_1');
});

test('BigModel rejects unauthorized responses without switching model or endpoint', async t => {
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async(url,init)=>{
    const request=new Request(url,init); calls++;
    assert.equal(request.url,'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal((await request.json()).model,'glm-5.3-flash');
    return new Response(JSON.stringify({error:{message:'Invalid API key',code:'401'}}),{status:401,headers:{'Content-Type':'application/json'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const runtime=await createModelRuntime('bigmodel','invalid-fixture-key');
  const result=await runtime.completeSimple(runtime.getModel('bigmodel','glm-5.3-flash'),{messages:[{role:'user',content:'Review.',timestamp:1}]});
  assert.equal(result.stopReason,'error'); assert.equal(calls,1);
});
