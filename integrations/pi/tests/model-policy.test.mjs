import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {createModelRuntime,createPiRuntime,createPiRuntimeFactory} from '../src/runtime.ts';
import {resolveModelPolicy,requestHash} from '../src/model-policy.ts';
import {microRuntime} from '../../../eval/microeval/runtime.mjs';

const selected={provider:'bigmodel',modelId:'glm-5.3-flash'};
async function fixture(t){
 const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'mw-model-policy-')),prior=globalThis.fetch;
 t.after(async()=>{globalThis.fetch=prior;assert.ok(resolve(root).startsWith(parent+sep));await rm(root,{recursive:true,force:true});});
 return root;
}
function completion(model,turn){
 const delta=turn===1?{reasoning_content:'Read frozen source.',tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read_source',arguments:'{}'}}]}:{content:'Done.'};
 return new Response('data: '+JSON.stringify({id:'offline',object:'chat.completion.chunk',model,created:1,choices:[{index:0,delta,finish_reason:turn===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
const sourceTool={name:'read_source',description:'Read immutable source',schema:{type:'object',properties:{}},execute:async()=>({source:'return 1'})};
test('growing tool history preserves Pi output clamping through the evaluation contract',async t=>{
 const root=await fixture(t),catalog=await createModelRuntime(selected.provider,'offline-secret'),requests=[],errors=[];
 globalThis.fetch=async(url,init)=>{requests.push(await new Request(url,init).json());return completion(selected.modelId,requests.length);};
 const tools=['read_diff','search_text','read_source','submit_review'].map(name=>({...sourceTool,name,execute:async()=>({source:'x'.repeat(150000)})}));
 const config={model:selected,temperature:0,top_p:1,thinking:{type:'enabled',clear_thinking:false},thinkingLevel:'low',maxTokens:32768};
 const runtime=await microRuntime({repositoryPath:root,stateDir:root,runDir:root,model:selected,tools,evaluation:{tools:'text-only'}},catalog,{case:{},prefix:{},prompt:'Review.',arm:'A',config,onExtensionError:e=>errors.push(e)});
 try{await runtime.prompt('Review.',new AbortController().signal);assert.equal(requests.length,2);assert.equal(requests[0].max_tokens,32768);assert(requests[1].max_tokens>0&&requests[1].max_tokens<32768);assert.equal(runtime.configuration().inference.resolved.maxOutputTokens,32768);assert.deepEqual(errors,[]);
  const audits=(await readFile(join(root,'session.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.customType==='mergewarden.provider-request.v1');assert.equal(audits[1].data.parameters.max_tokens,requests[1].max_tokens);
 }finally{runtime.dispose();}
});

test('GLM native Pi capabilities expose exactly low, high, max; run policy never changes the catalog',async()=>{
 const catalog=await createModelRuntime(),model=catalog.getModel(selected.provider,selected.modelId),before=JSON.stringify(model);
 assert.deepEqual(getSupportedThinkingLevels(model),['low','high','max']);
 const product=resolveModelPolicy(model);
 assert.equal(product.thinkingLevel,'low');assert.equal(product.model.maxTokens,8192);assert.equal(product.model.contextWindow,65536);
 assert.deepEqual(product.configuration.capabilities,{contextWindow:1000000,maxOutputTokens:131072});
 const experiment=resolveModelPolicy(model,{thinkingLevel:'max',maxOutputTokens:32768,temperature:0,topP:1});
 assert.equal(experiment.model.maxTokens,32768);assert.deepEqual(experiment.model.samplingParams,{temperature:0,top_p:1});
 assert.equal(JSON.stringify(model),before);
 for(const level of ['off','minimal','medium','xhigh','typo'])assert.throws(()=>resolveModelPolicy(model,{thinkingLevel:level}),/Unsupported thinking/);
 for(const maxOutputTokens of [0,-1,1.2,NaN,Infinity,131073])assert.throws(()=>resolveModelPolicy(model,{maxOutputTokens}),/Invalid output/);
 assert.throws(()=>resolveModelPolicy(model,{contextWindow:1000001}),/Invalid context/);
 assert.throws(()=>resolveModelPolicy(model,{topP:0}),/Invalid topP/);
});

test('every GLM effort survives the native session tool loop; final request audit matches HTTP bytes',async t=>{
 const root=await fixture(t),catalog=await createModelRuntime(selected.provider,'offline-secret');
 for(const level of ['low','high','max']){
  const runDir=join(root,level);await mkdir(runDir);const requests=[];
  globalThis.fetch=async(url,init)=>{
   const request=new Request(url,init),body=await request.json();requests.push(body);
   assert.equal(request.url,'https://open.bigmodel.cn/api/paas/v4/chat/completions');
   assert.equal(request.headers.get('authorization'),'Bearer offline-secret');
   return completion(selected.modelId,requests.length);
  };
  const runtime=await createPiRuntime({repositoryPath:root,stateDir:root,runDir,model:selected,inference:{thinkingLevel:level,maxOutputTokens:16384,temperature:0,topP:1},tools:[sourceTool]},catalog);
  try{
   await runtime.prompt('Review.',new AbortController().signal);
   assert.equal(requests.length,2);
   for(const body of requests){
    assert.equal(body.model,selected.modelId);assert.equal(body.reasoning_effort,level);assert.equal(body.max_tokens,16384);
    assert.equal(body.temperature,0);assert.equal(body.top_p,1);assert.equal(body.tool_stream,true);
    assert.deepEqual(body.thinking,{type:'enabled',clear_thinking:false});
    assert.doesNotMatch(JSON.stringify(body),/mergewarden\.provider-request/);
   }
   const assistant=requests[1].messages.find(m=>m.role==='assistant');
   assert.equal(assistant.reasoning_content,'Read frozen source.');assert.equal(assistant.tool_calls[0].id,'call_read');
   assert.ok(requests[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='call_read'));
   const lines=(await readFile(join(runDir,'session.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
   const records=lines.filter(e=>e.type==='custom'&&e.customType==='mergewarden.provider-request.v1');
   assert.equal(records.length,2);
   records.forEach((entry,i)=>{assert.equal(entry.data.sha256,requestHash(requests[i]));assert.equal(entry.data.parameters.reasoning_effort,level);assert.equal(entry.data.parameters.max_tokens,16384);});
   assert.doesNotMatch(JSON.stringify(records),/offline-secret|Read frozen source/);
   const config=runtime.configuration();assert.equal(config.thinkingLevel,level);assert.equal(config.inference.requestCount,2);
   assert.equal(config.inference.lastRequestSha256,records[1].data.sha256);assert.equal(config.inference.capabilities.maxOutputTokens,131072);
  }finally{runtime.dispose();}
 }
});

test('invalid explicit policy is rejected before any request or session file',async t=>{
 const root=await fixture(t);let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('No network allowed');};
 const factory=createPiRuntimeFactory('offline-secret');
 await assert.rejects(factory({repositoryPath:root,stateDir:root,runDir:root,model:selected,inference:{thinkingLevel:'off'},tools:[]}),/Unsupported thinking/);
 assert.equal(calls,0);await assert.rejects(readFile(join(root,'session.jsonl')),e=>e.code==='ENOENT');
});

test('built-in Anthropic uses the same assembly and its own Pi protocol without GLM fields',async t=>{
 const root=await fixture(t),catalog=await createModelRuntime('anthropic','offline-anthropic');
 const model=catalog.getModels('anthropic').find(m=>m.api==='anthropic-messages');assert.ok(model);
 const requests=[];
 globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests.push(body);
  const events=[
   {type:'message_start',message:{id:'msg_offline',type:'message',role:'assistant',model:model.id,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Done.'}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},
   {type:'message_stop'}
  ];
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const runtime=await createPiRuntime({repositoryPath:root,stateDir:root,runDir:root,model:{provider:'anthropic',modelId:model.id},tools:[]},catalog);
 try{
  await runtime.prompt('Review.',new AbortController().signal);assert.equal(requests.length,1);
  assert.equal(requests[0].model,model.id);assert.equal(requests[0].reasoning_effort,undefined);assert.equal(requests[0].tool_stream,undefined);
  assert.notEqual(requests[0].thinking?.type,'enabled');assert.equal(runtime.configuration().inference.requestCount,1);
 }finally{runtime.dispose();}
 assert.throws(()=>resolveModelPolicy(model,{temperature:0}),/Sampling overrides/);
});
