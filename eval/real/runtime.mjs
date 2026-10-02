import {createPiRuntimeFactory} from '../../integrations/pi/src/runtime.ts';
/** Experiments select run policy through the same Pi assembly as production. */
export function createEvaluationRuntimeFactory(key,experiment){
 if(!key?.trim())throw Error('Explicit credential environment unavailable');
 const {maxTokens,providerReasoningEffort='low'}=experiment;
 if(!Number.isInteger(maxTokens)||maxTokens<8192||maxTokens>32768||!['low','high','max'].includes(providerReasoningEffort))throw Error('Invalid evaluation model budget; freeze a new explicit reasoning policy');
 const factory=createPiRuntimeFactory(key);
 return async options=>{
  const runtime=await factory({...options,inference:{...options.inference,maxOutputTokens:maxTokens,thinkingLevel:providerReasoningEffort}}),configuration=runtime.configuration;
  return {...runtime,configuration(){return {...configuration(),providerReasoningEffort};}};
 };
}
