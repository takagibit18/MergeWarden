import {INTENTS} from './contracts.mjs';
const keys = (x, expected) => x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).sort().join('|')===[...expected].sort().join('|');
export function parsePrediction(text, allowedUnits) {
  const fail=reason=>({status:'FORMAT_FAILURE',prediction:null,reason});
  let value;try{value=JSON.parse(text);}catch{return fail('invalid JSON');}
  if(!keys(value,['investigations'])||!Array.isArray(value.investigations)||value.investigations.length>2)return fail('invalid investigations envelope');
  const ids=new Set(allowedUnits.map(u=>typeof u==='string'?u:u.changeUnitId)),pairs=new Set();
  for(const p of value.investigations){
    if(!keys(p,['changeUnitId','intent','rationale'])||!ids.has(p.changeUnitId)||!INTENTS.includes(p.intent)||typeof p.rationale!=='string'||[...p.rationale].length>240)return fail('invalid plan');
    const key=JSON.stringify([p.changeUnitId,p.intent]);if(pairs.has(key))return fail('duplicate pair');pairs.add(key);
  }
  return {status:'OK',prediction:value,reason:null};
}
