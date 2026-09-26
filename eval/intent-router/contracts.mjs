export const EXPERIMENT = 'changeunit-semantic-intent-shadow-1';
export const INTENTS = Object.freeze(['CALLER_CHECK', 'IMPORT_CHECK', 'INHERITANCE_CHECK', 'RELATIONSHIP_CHECK']);
export const OUTPUT_SCHEMA = Object.freeze({type:'object',additionalProperties:false,required:['investigations'],properties:{investigations:{type:'array',minItems:0,maxItems:2,items:{type:'object',additionalProperties:false,required:['changeUnitId','intent','rationale'],properties:{changeUnitId:{type:'string'},intent:{type:'string',enum:INTENTS},rationale:{type:'string',maxLength:240}}}}}});
export const MODEL_CONFIG = Object.freeze({provider:'bigmodel',modelId:'glm-5.3-flash',apiKeyEnv:'MERGEWARDEN_API_KEY',temperature:0,top_p:1,reasoning:'medium',thinking:{type:'enabled',clear_thinking:false},maxTokens:8192,timeoutMs:180000,maxRetries:0,tools:[]});
export const GATE = Object.freeze({publicDefects:6,publicClean:8,actionableDefects:4,opportunityRecall:0.75,recoveredDefects:3,meanCleanPlans:0.5,cleanTwoPlans:1,formatFailures:0,providerFailures:0});
export const intentRoute = intent => intent === 'RELATIONSHIP_CHECK' ? 'STRUCTURAL_ESCALATION' : intent;
// PythonResolver emits CALLS for function AND class targets (constructor calls).
// This is a static product capability; no per-case relation query guides admission.
export function legalIntents(kind) { return kind === 'function' ? ['CALLER_CHECK','RELATIONSHIP_CHECK'] : kind === 'class' ? ['CALLER_CHECK','INHERITANCE_CHECK','RELATIONSHIP_CHECK'] : kind === 'file' ? ['IMPORT_CHECK','RELATIONSHIP_CHECK'] : []; }
export function legalPlans(units, cap=32) {
  const all = units.filter(u=>u.resolution==='resolved').flatMap(u=>legalIntents(u.kind).map(intent=>({changeUnitId:u.changeUnitId,intent})));
  return {plans:all.slice(0,cap),oraclePlansOmitted:Math.max(0,all.length-cap),confidence:all.length>cap?'LIMITED':'HIGH'};
}
