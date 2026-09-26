import assert from 'node:assert/strict';
import {createPiRuntime} from '../../integrations/pi/src/runtime.ts';
import {INVESTIGATION_MESSAGE} from '../../src/engine/investigation-contracts.ts';
import {trigger} from './common.mjs';
/** Only admission/transport hooks: Pi still owns the complete main review loop. */
export async function microRuntime(options,modelRuntime,{case:c,prefix,prompt,arm,config,onPackage=async()=>{},onPayload=async()=>{},onExtensionError=()=>{}}){
 const names=['read_diff','search_text','read_source','submit_review',...(arm==='B'?['expand_structural_candidate']:[])];
 const tools=options.tools.filter(t=>names.includes(t.name));assert.deepEqual(tools.map(t=>t.name).sort(),names.sort());
 const service=options.routing?.dispatch;assert.equal(!!service,arm==='B');
 let started=false,delivered=false;
 const extension=pi=>{
  pi.on('before_agent_start',async()=>{
   if(started)return;started=true;
   if(!service)return;
   for(const o of prefix.observations)service.observe(o);
   const pack=await service.dispatchRegistered(trigger(c),c.unit);
   assert.equal(pack.snapshotId,c.snapshotId);assert.equal(pack.generationId,c.generationId);
   assert.deepEqual(pack.investigations[0].changeUnits.filter(u=>u.entity).map(u=>u.entity.entityId),[c.unit.entity.entityId]);
   assert.ok(['context_returned','coverage_limited','no_definite_relation'].includes(pack.terminal),'Mechanical investigation failure: '+pack.terminal);
   assert.ok(pack.sources.length<=1);await onPackage(pack);service.queued(pack);
   return {message:{customType:INVESTIGATION_MESSAGE,content:JSON.stringify(pack),display:true}};
  });
  pi.on('before_provider_request',async event=>{
   const payload=event.payload;payload.temperature=config.temperature;payload.top_p=config.top_p;
   assert.equal(payload.model,config.model.modelId);assert.equal(payload.max_tokens,config.maxTokens);
   assert.deepEqual(payload.thinking,config.thinking);
   assert.deepEqual(payload.tools.map(t=>t.function.name).sort(),names);
   if(service){service.providerPayload(payload);assert.equal(service.hasPending(),false,'CandidateCatalog not provider-delivered');assert.equal(service.metrics.packagesDelivered,1);delivered=true;}
   await onPayload(payload);return payload;
  });
  pi.on('tool_result',event=>{
   if(!service)return;let result;try{result=JSON.parse(event.content.find(c=>c.type==='text').text);}catch{return;}
   service.observe({toolName:event.toolName,toolCallId:event.toolCallId,input:event.input,result,isError:event.isError});
  });
 };
 const runtime=await createPiRuntime({...options,tools},modelRuntime,{extensions:[extension],firstAttemptOnly:true,onExtensionError});
 return {...runtime,async prompt(base,signal){await runtime.prompt(base+'\n\n'+prompt,signal);if(service)assert(delivered,'Mechanical structural delivery absent');}};
}
