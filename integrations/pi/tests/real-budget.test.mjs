import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createEvaluationRuntimeFactory} from '../../../eval/real/runtime.mjs';
import {createModelRuntime} from '../src/runtime.ts';
import {validateRuntime} from '../../../eval/real/experiment.mjs';

test('real evaluation budget reaches the actual Pi HTTP payload without changing the product catalog',async t=>{
 const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'real-pi-budget-'));
 const prior=globalThis.fetch,requests=[];
 t.after(async()=>{globalThis.fetch=prior;assert.ok(resolve(root).startsWith(parent+sep));await rm(root,{recursive:true,force:true});});
 globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  requests.push(JSON.parse(init.body));
  return new Response('data: '+JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:'glm-5.3-flash',choices:[{index:0,delta:{role:'assistant',content:'Budget transport test.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 const experiment={outputDirectory:root,maxTokens:16384,providerReasoningEffort:'high',thinkingLevel:'high',modelApi:'openai-completions',modelBaseUrl:'https://open.bigmodel.cn/api/paas/v4/'};
 for(const [arm,names] of [['T0',['read_source']],['G0',['graph_lookup']],['G1',['search_entity']]]){
  const runDir=join(root,arm);await mkdir(runDir);await mkdir(join(root,'state'),{recursive:true});
  const runtime=await createEvaluationRuntimeFactory('offline-test-key',experiment)({runId:arm,runDir,stateDir:join(root,'state'),repositoryPath:root,model:{provider:'bigmodel',modelId:'glm-5.3-flash'},evaluation:{tools:arm==='T0'?'text-only':arm==='G0'?'text+graph':'text+locagent'},tools:names.map(name=>({name,description:'Offline tool',schema:{type:'object',properties:{}},execute:async()=>({})}))});
  try{validateRuntime(runtime.configuration(),experiment,arm);await runtime.prompt('Check the transport configuration.',new AbortController().signal);}finally{runtime.dispose();}
 }
 assert.equal(requests.length,3);
 for(const payload of requests){assert.equal(payload.max_tokens,16384);assert.equal(payload.reasoning_effort,'high');assert.equal(payload.thinking.type,'enabled');assert.equal(payload.model,'glm-5.3-flash');}
 const product=await createModelRuntime('bigmodel','offline-test-key'),model=product.getModel('bigmodel','glm-5.3-flash');
 assert.equal(model.maxTokens,131072);assert.equal(model.compat.supportsReasoningEffort,true);
});
