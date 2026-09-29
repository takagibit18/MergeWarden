// Evaluation-only, single native Pi session. No review tools, learning tools or repair loop.
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createAgentSession,SessionManager,SettingsManager} from '../../integrations/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {reviewResources} from '../../integrations/pi/src/review-resources.ts';
import {PiSessionJournal} from '../../integrations/pi/src/journal.ts';
import {resolveModelPolicy,requestHash} from '../../integrations/pi/src/model-policy.ts';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
export async function modelCall(modelRuntime,model,directory,systemPrompt,input){
 await mkdir(directory);await writeJson(join(directory,'input.json'),input);await writeJson(join(directory,'started.json'),{at:new Date().toISOString(),prompt:systemPrompt,promptSha256:sha256(systemPrompt),model,inputSha256:sha256(JSON.stringify(input)),timeoutMs:60000,outputTokensRequestedMax:4096,firstAttemptOnly:true});
 const started=performance.now(),policy=resolveModelPolicy(modelRuntime.getModel(model.provider,model.modelId),{thinkingLevel:'max',maxOutputTokens:4096});
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:60000}}});settingsManager.setProjectTrusted(false);
 let requests=0,journal;const extension=pi=>{pi.on('tool_call',()=>({block:true,reason:'Evaluation has no tools'}));pi.on('before_provider_request',event=>{requests++;if(requests>1)throw Error('Single-request evaluation budget');manager.appendCustomEntry('mergewarden.evaluation-request.v1',{ordinal:requests,sha256:requestHash(event.payload),model,policy:policy.configuration});journal.checkpoint();});};
 const resourceLoader=await reviewResources({cwd:directory,systemPrompt,extensionFactories:[extension]});await resourceLoader.reload();
 const file=join(directory,'session.jsonl');closeSync(openSync(file,'wx',0o600));const manager=SessionManager.open(file,directory,directory);
 const created=await createAgentSession({cwd:directory,agentDir:directory,modelRuntime,model:policy.model,thinkingLevel:policy.thinkingLevel,sessionManager:manager,settingsManager,resourceLoader,noTools:'builtin',tools:[],customTools:[]});const session=created.session;
 journal=new PiSessionJournal(manager,{durable:true,onFailure:()=>{void session.abort();}});const unsubscribe=session.agent.subscribe(e=>{if(e.type==='message_end'||e.type==='agent_end')journal.checkpoint();});
 let timer,status='failed',answer,error;
 try{if(created.extensionsResult.errors.length)throw Error('Evaluation extension failed');await session.bindExtensions({onError:()=>{void session.abort();}});if(session.getAllTools().length)throw Error('Unexpected evaluation tool');
 await Promise.race([session.prompt(JSON.stringify(input),{expandPromptTemplates:false}),new Promise((_,reject)=>{timer=setTimeout(()=>{void session.abort();reject(Error('Evaluation timeout'));},60000);})]);
 const last=[...session.messages].reverse().find(m=>m.role==='assistant');if(!last||['error','aborted','length'].includes(last.stopReason))throw Error('Evaluation provider did not finish normally');
 const text=last.content.filter(c=>c.type==='text').map(c=>c.text).join('');answer=JSON.parse(text);status='completed';await writeJson(join(directory,'output.json'),answer);
 }catch(e){error=e.message;}finally{clearTimeout(timer);journal.checkpoint();unsubscribe();const t=session.getSessionStats().tokens;await writeJson(join(directory,'metrics.json'),{status,error,requests,elapsedMs:performance.now()-started,usage:t.total?{input:t.input+t.cacheRead+t.cacheWrite,output:t.output,total:t.total}:null,providerHardOutputLimitVerified:false});session.dispose();}
 return {status,answer,error};
}
