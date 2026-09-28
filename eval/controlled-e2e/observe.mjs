/** Preserve nested fetch causes without serializing credentials or arbitrary objects. */
export function errorDetails(error,redact=x=>String(x),depth=0){return {name:error?.name??'Error',message:redact(error?.message??error),...(error?.code?{code:redact(error.code)}:{}),...(error?.cause&&depth<3?{cause:errorDetails(error.cause,redact,depth+1)}:{})};}
/** Transport observation only. Pi remains the owner of parsing and tool execution. */
export async function observeResponse(response,{ordinal,now,requestStartedMs,redact=x=>String(x),signal}){
 const reader=response.body?.getReader(),decoder=new TextDecoder(),chunks=[];
 const record={ordinal,status:response.status,requestStartedMs,firstDeltaMs:null,firstReasoningMs:null,firstTextMs:null,firstToolDeltaMs:null,finishEvents:[],usageEvents:[],streamComplete:false,sawDone:false,parseErrors:0,reasoningChars:0,textChars:0,toolArgumentChars:0,streamError:null};
 let pending='',data=[];
 function event(){if(!data.length)return;const raw=data.join('\n');data=[];if(raw==='[DONE]'){record.sawDone=true;return;}
  try{const v=JSON.parse(raw),ms=now();if(v.error)record.providerError=redact(JSON.stringify(v.error));
   for(const c of v.choices??[]){const d=c.delta??{};
    if(d.content||d.reasoning_content||d.reasoning||d.tool_calls?.length)record.firstDeltaMs??=ms;
    const reasoning=d.reasoning_content??d.reasoning;
    if(typeof reasoning==='string'&&reasoning){record.firstReasoningMs??=ms;record.reasoningChars+=reasoning.length;}
    if(typeof d.content==='string'&&d.content){record.firstTextMs??=ms;record.textChars+=d.content.length;}
    if(d.tool_calls?.length){record.firstToolDeltaMs??=ms;for(const t of d.tool_calls)record.toolArgumentChars+=(t.function?.arguments??'').length;}
    if(c.finish_reason)record.finishEvents.push({elapsedMs:ms,reason:c.finish_reason});
   }
   if(v.usage)record.usageEvents.push({elapsedMs:ms,usage:v.usage});
  }catch{record.parseErrors++;}
 }
 function line(s){if(s==='')event();else if(s.startsWith('data:'))data.push(s.slice(5).replace(/^ /,''));}
 const cancel=()=>{record.streamError='observation cancelled';void reader?.cancel().catch(()=>{});};
 signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;const s=decoder.decode(value,{stream:true});chunks.push(s);pending+=s;let i;while((i=pending.indexOf('\n'))>=0){line(pending.slice(0,i).replace(/\r$/,''));pending=pending.slice(i+1);}}
  const tail=decoder.decode();chunks.push(tail);pending+=tail;if(pending)line(pending);event();record.streamComplete=!record.streamError;
 }catch(e){record.streamError=redact(e);}finally{signal?.removeEventListener('abort',cancel);}
 return {...record,endedMs:now(),body:chunks.join('')};
}
const token=(u,key)=>Number.isFinite(u?.[key])&&u[key]>=0?u[key]:null;
/** A before-send audit is not an HTTP receipt. Keep unsent trailing preparations explicit. */
export function reconcileRequests(audits,wireHashes){
 const matches=audits.length>=wireHashes.length&&audits.every((a,i)=>a.ordinal===i+1)&&wireHashes.every((h,i)=>audits[i]?.sha256===h);
 return {matches,prepared:audits.length,sent:wireHashes.length,preparedNotSent:audits.slice(wireHashes.length).map(a=>({ordinal:a.ordinal,sha256:a.sha256,parameters:a.parameters}))};
}
export function usageSummary(responses,requests){
 const rows=responses.map(r=>{const u=r.usageEvents.at(-1)?.usage;return {ordinal:r.ordinal,input:token(u,'prompt_tokens'),output:token(u,'completion_tokens'),reasoning:token(u?.completion_tokens_details,'reasoning_tokens'),complete:r.streamComplete&&r.sawDone&&!r.streamError};});
 const knownInput=rows.reduce((n,r)=>n+(r.input??0),0),knownOutput=rows.reduce((n,r)=>n+(r.output??0),0);
 const complete=rows.length===requests&&rows.every(r=>r.complete&&r.input!==null&&r.output!==null);
 return {complete,inputTokens:complete?knownInput:null,outputTokens:complete?knownOutput:null,knownInputTokens:knownInput,knownOutputTokens:knownOutput,reasoningTokens:complete&&rows.every(r=>r.reasoning!==null)?rows.reduce((n,r)=>n+r.reasoning,0):null,requestsWithUsage:rows.filter(r=>r.input!==null&&r.output!==null).length,requestsMissingUsage:requests-rows.filter(r=>r.input!==null&&r.output!==null).length,rows};
}
export function blockerReasons({error,extensionErrors=[],transport=[],responses=[],trace,arm,manifest,pack,auditMatches,observerErrors=[]}){
 return [error&&'runner_error',extensionErrors.length&&'extension_error',transport.some(t=>t.error||t.status!==200)&&'transport_error',responses.some(r=>r.providerError||r.parseErrors||(!r.sawDone&&r.streamComplete))&&'invalid_provider_stream',trace?.issues.some(i=>i.severity==='fatal')&&'invalid_native_journal',arm==='B'&&(!pack||manifest?.metrics?.dispatch?.packagesDelivered!==1)&&'context_not_delivered',!auditMatches&&'request_audit_mismatch',observerErrors.length&&'observation_failed'].filter(Boolean);
}
