import {createPiRuntime} from '../../integrations/pi/src/runtime.ts';
import {inference,checkPayload} from './ab-contract.mjs';
/** Observe native Pi requests without replacing the production routing extension. */
export async function abRuntime(options,catalog,{arm,onPayload=async()=>{},onExtensionError=()=>{}}){
 const observer=pi=>{pi.on('before_provider_request',async event=>{checkPayload(event.payload,arm);await onPayload(event.payload);});};
 const runtime=await createPiRuntime({...options,inference},catalog,{extensions:[observer],firstAttemptOnly:true,preserveRouting:true,onExtensionError});
 const configuration=runtime.configuration;return {...runtime,configuration:()=>({...configuration(),authentication:{type:'oauth'}})};
}
