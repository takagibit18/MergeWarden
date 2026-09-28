import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {resolveModelPolicy} from '../../integrations/pi/src/model-policy.ts';
import {parseDecision} from './parse.mjs';
import {SYSTEM_PROMPT,userPrompt} from './prompt.mjs';
import {MODEL_CONFIG} from './contracts.mjs';
export function redact(value,key){return JSON.parse(JSON.stringify(value).split(key).join('[REDACTED]'));}
export class SemanticRouteRuntime{
  #key;#runtime;#model;#config;#policy;
  static async create(config=MODEL_CONFIG,env=process.env){const key=env[config.apiKeyEnv];if(!key?.trim())throw Error('Explicit API key environment variable is missing');const runtime=await createModelRuntime(config.provider,key);return new SemanticRouteRuntime(runtime,key,config);}
  constructor(runtime,key,config=MODEL_CONFIG){assert.ok(key);this.#key=key;this.#runtime=runtime;this.#config=config;this.#model=runtime.getModel(config.provider,config.modelId);assert.ok(this.#model);assert.equal(this.#model.baseUrl,'https://open.bigmodel.cn/api/paas/v4/');this.#policy=resolveModelPolicy(this.#model,{thinkingLevel:config.reasoning,maxOutputTokens:config.maxTokens,temperature:config.temperature,topP:config.top_p});this.#model=this.#policy.model;}
  async decide(input,{fetch:requestFetch}={}){
    const config=this.#config,started=performance.now();let payload=null,requests=0,httpStatus=null,response;
    const context={systemPrompt:SYSTEM_PROMPT,messages:[{role:'user',content:userPrompt(input),timestamp:0}],tools:[]};
    try{response=await this.#runtime.completeSimple(this.#model,context,{reasoning:this.#policy.thinkingLevel,maxRetries:0,timeoutMs:config.timeoutMs,signal:AbortSignal.timeout(config.timeoutMs),
      fetch:async(url,init)=>{requests++;if(requests!==1)throw Error('Retry forbidden');assert.equal(new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).href,this.#model.baseUrl+'chat/completions');return (requestFetch??globalThis.fetch)(url,init);},
      onPayload:p=>{assert.equal(p.model,config.modelId);assert.ok(!p.tools||p.tools.length===0);assert.equal(p.temperature,config.temperature);assert.equal(p.top_p,config.top_p);assert.deepEqual(p.thinking,config.thinking);assert.equal(p.messages.length,2);assert.equal(p.messages[0].role,'system');assert.equal(p.messages[1].role,'user');payload=structuredClone(p);},onResponse:r=>{httpStatus=r.status;}});
    }catch(error){response={role:'assistant',content:[],stopReason:'error',errorMessage:String(error.message),usage:null};}
    const raw=redact({role:response.role,content:response.content,stopReason:response.stopReason,errorMessage:response.errorMessage??null,usage:response.usage??null},this.#key);
    const text=raw.content.filter(c=>c.type==='text').map(c=>c.text).join('');
    const operationalFailure=['error','aborted'].includes(raw.stopReason);
    const parsed=operationalFailure?{status:'PROVIDER_FAILURE',decision:null,rationale:null}:raw.stopReason!=='stop'||raw.content.some(c=>c.type==='toolCall')?{status:'FORMAT_FAILURE',decision:null,rationale:null}:parseDecision(text);
    const usage=raw.usage;const observedTokens=usage&&usage.totalTokens>0;
    return {caseId:input.caseId,provider:config.provider,modelId:config.modelId,raw,rawText:text,parsed,wirePayload:payload?redact(payload,this.#key):null,requests,httpStatus,latencyMs:performance.now()-started,usage:observedTokens?{inputTokens:usage.input+usage.cacheRead+usage.cacheWrite,outputTokens:usage.output,totalTokens:usage.totalTokens}:null,usageUnavailable:!observedTokens,toolsExposed:0,toolExecutions:0};
  }
}
