import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>obj?.[k]!==undefined).map(k=>[k,obj[k]]));
export function projectInput(alias,prefix,replay){
  assert.match(alias,/^R\d{2}$/);assert.equal(prefix.caseId,replay.caseId);assert.equal(replay.routeTriggered,false);
  const diff=[],observed=[];let last=0;
  for(const o of prefix.observations){assert.ok(o.ordinal>last);last=o.ordinal;assert.ok(['read_diff','read_source','search_text'].includes(o.toolName),'Post-route or unsupported tool in prefix');assert.equal(o.result.snapshotId,prefix.snapshotId);
    const item={ordinal:o.ordinal,tool:o.toolName,input:pick(o.input,['path','revision','offset','cursor','limit','startLine','endLine','query','caseSensitive']),isError:!!o.isError};
    if(o.toolName==='read_diff'){assert.ok(prefix.changedPaths.includes(o.result.path));item.result=pick(o.result,['path','status','lines','offset','totalLines','nextCursor','truncated','warnings']);diff.push(item);}
    else if(o.toolName==='read_source'){assert.ok(prefix.changedPaths.includes(o.result.path),'Untouched source is forbidden');item.result=pick(o.result,['path','revision','status','text','startLine','endLine','totalLines','contentSha256','truncated','warnings']);observed.push(item);}
    else{item.result={...pick(o.result,['revision','status','truncated','coverage','warnings']),items:(o.result.items??[]).map(m=>pick(m,['path','line','startLine','endLine','column','endColumn'])),note:'Search result metadata only; source snippets omitted uniformly.'};observed.push(item);}
  }
  const checkpoint=replay.checkpoints.at(-1);assert.ok(checkpoint);assert.equal(checkpoint.ordinal,last);
  return {caseId:alias,snapshotId:prefix.snapshotId,preRouteContext:{changedPaths:prefix.changedPaths,diff,observed},deterministicOutcome:{outcome:'NO_ROUTE',highSignals:replay.highSignals,weakSignals:replay.weakSignals,searchPressure:replay.searchPressure,searchPressureReached:replay.searchPressureReached,currentSearchCount:replay.currentSearchCount,textVerified:replay.textVerified,seenPaths:replay.seenPaths,routeHistory:replay.routeHistory,investigationState:checkpoint.state,decisionOrdinal:last}};
}
