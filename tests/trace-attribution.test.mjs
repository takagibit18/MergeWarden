import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTrace,decodePiTrace} from '../src/eval/traces.ts';
import {summarizeTraces} from '../eval/traces.mjs';

const snapshotId='snapshot-a',hash='a'.repeat(64);
const evidence={snapshotId,revision:'head',path:'caller.py',startLine:1,endLine:4,contentSha256:hash};
const finding={id:'f1',title:'contract',claim:'caller breaks',trigger:'call',impact:'exception',severity:'high',evidence:[evidence]};
const symbol={id:'callee',snapshotId,path:'callee.py',startLine:1,endLine:2};
const edge={id:'edge1',snapshotId,fromId:'caller',toId:'callee',relation:'CALLS',resolution:'resolved_import_alias',sourcePath:'caller.py',sourceLine:3,sourceEndLine:3};
const page=items=>({snapshotId,status:'ok',items,coverage:{},warnings:[]});
const source={...evidence,status:'ok',text:'frozen source'};
function fixture(){
 const entries=[{type:'session',version:3}];let serial=0,leaf=null,toolId=0;
 const append=message=>{const e={type:'message',id:'e'+(++serial),parentId:leaf,message};entries.push(e);leaf=e.id;return e.id;};
 const issue=(name,args={})=>{const id='t'+(++toolId);append({role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]});return id;};
 const result=(id,name,value,isError=false)=>append({role:'toolResult',toolCallId:id,toolName:name,isError,content:[{type:'text',text:JSON.stringify(value)}]});
 const call=(name,args,value)=>{const id=issue(name,args);result(id,name,value);return id;};
 const lookup=()=>call('graph_lookup',{query:'callee',limit:10},page([symbol]));
 const neighbors=(changes={})=>call('graph_neighbors',{symbolId:'callee',relation:'CALLS',direction:'incoming',limit:10},page([{...edge,...changes}]));
 const read=(value=source)=>call('read_source',{path:value.path,revision:value.revision,startLine:value.startLine,endLine:value.endLine},value);
 const submit=(f=finding)=>call('submit_review',{findings:[f],reviewedPaths:['callee.py']},{accepted:true});
 const analyze=(findings=[finding])=>analyzeTrace({runKey:'case/0/text+graph',snapshotId,findings,jsonl:entries.map(JSON.stringify).join('\n')});
 return {entries,append,issue,result,call,lookup,neighbors,read,submit,analyze};
}
test('strict incoming neighbor -> newly read caller -> accepted exact evidence gets graph-assisted credit',()=>{
 const f=fixture();f.lookup();f.neighbors();f.read();f.submit();const a=f.analyze();
 assert.equal(a.findings[0].discoveryPath,'graph_assisted');assert.equal(a.findings[0].chains[0].edgeId,'edge1');
 assert.equal(a.metrics.firstGraphToolOrdinal,1);assert.deepEqual(a.metrics.lookupToNeighbors,{converted:1,eligible:1,rate:1});assert.equal(a.metrics.neighborsToReadSource.rate,1);
 assert.equal(a.metrics.graphResponseTokens,null);assert(a.metrics.graphResponseTokenEstimate>0);
});
test('source already read before Graph gets no Graph discovery credit',()=>{
 const f=fixture();f.read();f.lookup();f.neighbors();f.read();f.submit();const a=f.analyze();assert.equal(a.findings[0].discoveryPath,'text_only');assert.equal(a.findings[0].chains[0].novelToText,false);
});
test('prior text search discovery, including base revision, keeps later Graph reconfirmation text-only',()=>{
 const f=fixture();f.call('search_text',{query:'callee',revision:'base'}, {...page([{path:'caller.py',line:3}]),revision:'base'});f.lookup();f.neighbors();f.read();f.submit();const a=f.analyze();assert.equal(a.findings[0].discoveryPath,'text_only');assert.equal(a.findings[0].chains[0].competingTextCallIds.length,1);
});
test('a pre-issued source call cannot be caused by a later Graph result',()=>{
 const f=fixture();f.lookup();const neighbor=f.issue('graph_neighbors',{symbolId:'callee',relation:'CALLS',direction:'incoming'});const read=f.issue('read_source',{path:'caller.py'});f.result(neighbor,'graph_neighbors',page([edge]));f.result(read,'read_source',source);f.submit();const a=f.analyze();assert.equal(a.findings[0].discoveryPath,'ambiguous');assert.equal(a.metrics.neighborsToReadSource.converted,0);
});
test('candidate, unresolved and outgoing provenance are not proven incoming caller discovery',()=>{
 for(const resolution of ['candidate','unresolved']){const f=fixture();f.lookup();f.neighbors({resolution});f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'ambiguous');}
 const f=fixture();f.lookup();f.call('graph_neighbors',{symbolId:'callee',relation:'CALLS',direction:'outgoing'},page([edge]));f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'ambiguous');
});
test('cross-snapshot result, missing submission or wrong evidence hash cannot claim assistance',()=>{
 const f=fixture();f.lookup();f.neighbors({snapshotId:'other'});f.read();f.submit();assert.notEqual(f.analyze().findings[0].discoveryPath,'graph_assisted');
 const g=fixture();g.lookup();g.neighbors();g.read();assert.equal(g.analyze().findings[0].discoveryPath,'ambiguous');
 const h=fixture();h.lookup();h.neighbors();h.read({...source,contentSha256:'b'.repeat(64)});h.submit();assert.equal(h.analyze().findings[0].discoveryPath,'ambiguous');
});
test('finding evidence must contain caller site, not just another range of the same file',()=>{
 const f=fixture(),other={...evidence,startLine:10,endLine:12},changed={...finding,evidence:[other]};f.lookup();f.neighbors();f.read({...source,...other});f.submit(changed);assert.notEqual(f.analyze([changed]).findings[0].discoveryPath,'graph_assisted');
});
test('lookup failure, empty hit and pending result remain in attempt denominator',()=>{
 const f=fixture();f.call('graph_lookup',{}, {...page([]),status:'error'});f.call('graph_lookup',{},page([]));f.issue('graph_lookup',{});const a=f.analyze([]);assert.equal(a.metrics.lookupCalls,3);assert.equal(a.metrics.lookupSuccessRate,1/3);assert.equal(a.metrics.lookupHitRate,0);assert.equal(a.metrics.lookupToNeighbors.rate,null);
});
test('lookup conversion links each neighbor to the most recent matching returned ID',()=>{
 const f=fixture();f.lookup();f.lookup();f.neighbors();const a=f.analyze([]);assert.equal(a.metrics.lookupToNeighbors.converted,1);assert.equal(a.metrics.lookupToNeighbors.eligible,2);
});
test('text-only findings and irrelevant Graph queries remain text-only',()=>{
 const f=fixture();f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'text_only');
 const g=fixture();g.lookup();g.read();g.submit();assert.equal(g.analyze().findings[0].discoveryPath,'text_only');
});
test('active branch only; malformed JSONL and orphan results are explicit integrity issues',()=>{
 const f=fixture();f.read();f.submit();const abandonedLeaf=f.entries.at(-1).id;f.lookup();const abandonedCall=f.entries.at(-2).id;
 f.entries.push({type:'custom',id:'final',parentId:abandonedLeaf});const a=f.analyze();assert.equal(a.metrics.graphToolCalls,0);assert(a.ignoredBranchEntries>0);assert(!a.calls.some(c=>c.callEntryId===abandonedCall));
 assert(decodePiTrace('{broken').issues.length>0);
 const orphan=fixture();orphan.result('missing','read_source',source);assert(orphan.analyze([]).traceIssues.length>0);
});
test('model self-attribution and details never substitute for the model-visible trace',()=>{
 const f=fixture();f.append({role:'assistant',content:[{type:'text',text:'Graph found this bug.'},{type:'thinking',thinking:'graph assisted'}]});f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'text_only');
});
test('expected Graph errors allow text fallback; unanswered calls remain ambiguous',()=>{
 const f=fixture();f.call('graph_lookup',{}, {...page([]),status:'error'});f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'text_only');
 const g=fixture();g.issue('graph_lookup',{});g.read();g.submit();assert.equal(g.analyze().findings[0].discoveryPath,'ambiguous');
});
test('cross-arm novelty requires semantic mappings, keeps partial Text attempts and rejects title matching as an oracle',()=>{
 const g=fixture();g.lookup();g.neighbors();g.read();g.submit();const graphRun={...g.analyze(),caseId:'case',repeat:0,arm:'text+graph',status:'completed',delivered:true,analysisStatus:'ok'};
 const t=fixture();const textRun={...t.analyze([]),runKey:'case/0/text-only',caseId:'case',repeat:0,arm:'text-only',status:'partial',delivered:true,analysisStatus:'ok'};
 const mappings=[{runKey:graphRun.runKey,status:'complete',predictions:[{predictionId:'f1',goldenId:'gold'}]},{runKey:textRun.runKey,status:'complete',predictions:[]}];
 assert.equal(summarizeTraces([textRun,graphRun]).graphAssistedWithoutTextMatch,null);
 const result=summarizeTraces([textRun,graphRun],mappings);assert.equal(result.graphAssistedWithoutTextMatch.length,1);assert.equal(result.graphAssistedWithoutTextMatch[0].textCompleted,false);
 mappings[1].predictions.push({predictionId:'different-title',goldenId:'gold'});assert.equal(summarizeTraces([textRun,graphRun],mappings).graphAssistedWithoutTextMatch.length,0);
});
test('Graph touching already read callee evidence cannot claim a later unrelated text-discovered caller',()=>{
 const f=fixture(),callee={...evidence,path:'callee.py',endLine:2},combined={...finding,evidence:[callee,evidence]};
 f.read({...source,...callee});f.lookup();f.read();f.submit(combined);assert.equal(f.analyze([combined]).findings[0].discoveryPath,'text_only');
});

test('usage records cached input and flags interrupted or missing usage without inventing billed zeroes',()=>{
 const f=fixture(),usage={input:10,output:5,cacheRead:7,cacheWrite:0,totalTokens:22};
 f.append({role:'assistant',content:[],stopReason:'stop',usage});
 const parent=f.entries.at(-1).id;f.append({role:'assistant',content:[],stopReason:'stop',usage:{...usage,input:999}});
 f.entries.push({type:'custom',id:'usage-branch',parentId:parent});
 let a=f.analyze([]);assert.equal(a.usage.reportedInputTokens,17);assert.equal(a.usage.reportedOutputTokens,5);assert.equal(a.usage.reportedTotalTokens,22);assert.equal(a.usage.cacheReadTokens,7);assert.equal(a.usage.incompleteUsage,false);
 f.append({role:'assistant',content:[],stopReason:'aborted',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}});
 f.entries.at(-1).parentId='usage-branch';
 a=f.analyze([]);assert.equal(a.usage.reportedTotalTokens,22);assert.equal(a.usage.interruptedResponses,1);assert.equal(a.usage.incompleteUsage,true);
 const missing=fixture();missing.append({role:'assistant',content:[],stopReason:'stop'});assert.equal(missing.analyze([]).usage.missingUsageResponses,1);
});
