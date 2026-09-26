import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {MODEL_CONFIG} from './contracts.mjs';
import {SYSTEM_PROMPT,userPrompt} from './prompt.mjs';
import {parsePrediction} from './parse.mjs';
const redact=(value,key)=>JSON.parse(JSON.stringify(value).split(key).join('[REDACTED]'));
export class SemanticIntentRuntime {
  #key;#runtime;#model;#config;
  static async create(config=MODEL_CONFIG,env=process.env){const key=env[config.apiKeyEnv];assert.ok(key?.trim(),'Explicit API key env missing');return new SemanticIntentRuntime(await createModelRuntime(config.provider,key),key,config);}
  constructor(runtime,key,config=MODEL_CONFIG){assert.ok(key);this.#key=key;this.#runtime=runtime;this.#config=config;this.#model=runtime.getModel(config.provider,config.modelId);assert.ok(this.#model);assert.equal(this.#model.baseUrl,'https://open.bigmodel.cn/api/paas/v4/');}
  async predict(input,{fetch:requestFetch}={}){
    const config=this.#config,started=performance.now();let payload=null,requests=0,httpStatus=null,response;
    const context={systemPrompt:SYSTEM_PROMPT,messages:[{role:'user',content:userPrompt(input),timestamp:0}],tools:[]};
    try{response=await this.#runtime.completeSimple(this.#model,context,{temperature:config.temperature,samplingParams:{top_p:config.top_p},reasoning:config.reasoning,maxTokens:config.maxTokens,maxRetries:0,timeoutMs:config.timeoutMs,signal:AbortSignal.timeout(config.timeoutMs),
      fetch:async(url,init)=>{requests++;assert.equal(requests,1,'Retry forbidden');assert.equal(new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).href,this.#model.baseUrl+'chat/completions');return (requestFetch??globalThis.fetch)(url,init);},
      onPayload:p=>{assert.equal(p.model,config.modelId);assert.ok(!p.tools||p.tools.length===0);assert.equal(p.temperature,config.temperature);assert.equal(p.top_p,config.top_p);assert.deepEqual(p.thinking,config.thinking);assert.equal(p.messages.length,2);payload=structuredClone(p);},onResponse:r=>httpStatus=r.status});
    }catch(error){response={role:'assistant',content:[],stopReason:'error',errorMessage:String(error.message),usage:null};}
    const raw=redact({role:response.role,content:response.content,stopReason:response.stopReason,errorMessage:response.errorMessage??null,usage:response.usage??null},this.#key),text=raw.content.filter(c=>c.type==='text').map(c=>c.text).join('');
    const parsed=['error','aborted'].includes(raw.stopReason)?{status:'PROVIDER_FAILURE',prediction:null,reason:raw.errorMessage}:raw.stopReason!=='stop'||raw.content.some(c=>c.type==='toolCall')?{status:'FORMAT_FAILURE',prediction:null,reason:'Non-final text output'}:parsePrediction(text,input.changeUnits);
    const u=raw.usage,observed=u&&u.totalTokens>0;
    return {caseId:input.caseId,provider:config.provider,modelId:config.modelId,raw,rawText:text,parsed,wirePayload:payload?redact(payload,this.#key):null,requests,httpStatus,latencyMs:performance.now()-started,usage:observed?{inputTokens:u.input+u.cacheRead+u.cacheWrite,outputTokens:u.output,totalTokens:u.totalTokens}:null,usageUnavailable:!observed,toolsExposed:0,toolExecutions:0};
  }
}
