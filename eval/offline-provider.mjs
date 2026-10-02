import { createModelRuntime } from '../integrations/pi/src/runtime.ts';
const {createAssistantMessageEventStream}=await import('../integrations/pi/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js');
/** Deliberately empty predictions. Only tests SDK/delivery/metrics wiring, never a quality oracle. */
export async function offlineProvider(paths,graphQuery){
 const runtime=await createModelRuntime('fixture','offline');let pathIndex=0;let graphDone=false;let submitted=false;
 runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{id:'offline',name:'scripted offline',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1024}],streamSimple(model,context){
  const previous=context.messages.filter(m=>m.role==='toolResult').at(-1);const page=previous?JSON.parse(previous.content[0].text):null;
  let request;
  if(previous?.toolName==='read_diff'&&!page.truncated)pathIndex++;
  if(pathIndex<paths.length){request={name:'read_diff',arguments:{path:paths[pathIndex],...(previous?.toolName==='read_diff'&&page.truncated?{cursor:page.nextCursor}:{})}};}
  else if(!graphDone&&context.tools.some(t=>t.name==='graph_lookup')){graphDone=true;request={name:'graph_lookup',arguments:{query:graphQuery,limit:10}};}
  else if(!submitted){submitted=true;request={name:'submit_review',arguments:{summary:'Scripted offline empty prediction. No model quality measurement.',reviewedPaths:paths,findings:[]}};}
  const content=request?[{type:'toolCall',id:crypto.randomUUID(),...request}]:[{type:'text',text:'Offline fixture complete.'}];
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),stopReason:request?'toolUse':'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;
 }});return runtime;
}
