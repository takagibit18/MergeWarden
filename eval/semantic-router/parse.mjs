import {DECISIONS} from './contracts.mjs';
// JSON.parse alone silently accepts duplicate keys. Scan only top-level keys,
// decoding escapes, so duplicated decisions cannot be hidden by key spelling.
function topKeys(raw){const keys=[];let depth=0;for(let i=0;i<raw.length;i++){
  const c=raw[i];if(c==='"'){const start=i;while(++i<raw.length){if(raw[i]==='\\'){i++;continue;}if(raw[i]==='"')break;}
    let next=i+1;while(/\s/.test(raw[next]??'')&&next<raw.length)next++;if(depth===1&&raw[next]===':')keys.push(JSON.parse(raw.slice(start,i+1)));
  }else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
}return keys;}
export function parseDecision(raw){try{const value=JSON.parse(raw),keys=topKeys(raw);
  if(!value||Array.isArray(value)||typeof value!=='object'||keys.length!==2||new Set(keys).size!==2||keys.some(k=>!['decision','rationale'].includes(k)))throw Error('EXACT_KEYS_REQUIRED');
  if(!DECISIONS.includes(value.decision))throw Error('INVALID_DECISION');if(typeof value.rationale!=='string'||!value.rationale.trim())throw Error('EMPTY_RATIONALE');
  return {status:'VALID',decision:value.decision,rationale:value.rationale};
}catch{return {status:'FORMAT_FAILURE',decision:null,rationale:null};}}
