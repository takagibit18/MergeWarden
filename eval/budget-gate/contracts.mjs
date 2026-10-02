import assert from 'node:assert/strict';
export const EXPERIMENT='progressive-structural-agent-executability-microeval-2';
export const EXECUTION='budget-gate-1';
// Only per-run host identities change. Entity IDs, evidence IDs, card text/order,
// paths, ranges, relations, previews and source contents remain exact.
export function canonicalPackage(value){
 if(Array.isArray(value))return value.map(canonicalPackage);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['runId','requestId','investigationId','candidateRefId'].includes(k)).map(([k,v])=>[k,canonicalPackage(v)]));
 return value;
}
export function mapStrings(value,fn){if(typeof value==='string')return fn(value);if(Array.isArray(value))return value.map(v=>mapStrings(v,fn));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mapStrings(v,fn)]));return value;}
export function budgetPayload(payload,{expected,pack,priorPack,state,previousState,first}){
 assert.equal(payload.max_tokens,8192);payload.max_tokens=32768;
 // Restore the exact frozen provider-facing cwd annotation after moving storage.
 // No instruction text is introduced; actual snapshot/session writes use new state.
 const current=payload.messages.find(m=>m.role==='system'),old=expected.messages.find(m=>m.role==='system');
 assert.equal(current.content.replaceAll(state.replaceAll('\\','/'),previousState.replaceAll('\\','/')),old.content);
 current.content=old.content;
 assert.deepEqual(payload.tools,expected.tools);
 const wire=JSON.parse(JSON.stringify(payload));
 const requestOptions=x=>Object.fromEntries(Object.entries(x).filter(([k])=>!['messages','tools'].includes(k)));
 assert.deepEqual(requestOptions(wire),{...requestOptions(expected),max_tokens:32768});
 if(pack)assert.deepEqual(canonicalPackage(pack),canonicalPackage(priorPack));
 if(first){
  const normalized=pack?mapStrings(wire,s=>s.replaceAll(JSON.stringify(pack),JSON.stringify(priorPack))):wire;
  normalized.max_tokens=8192;assert.deepEqual(normalized,expected,'First request changed beyond max_tokens and fresh package identities');
 }
 return {firstRequestEquivalent:first,onlySemanticRequestChange:'max_tokens:8192->32768',systemPromptByteIdentical:true,toolSchemasAndDescriptionsByteIdentical:true,catalogEquivalent:!!pack,identityRebindingOnly:!!pack};
}
