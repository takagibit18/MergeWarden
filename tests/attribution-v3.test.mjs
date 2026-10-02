import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTrace} from '../src/eval/traces.ts';
import {analyzeRetrieval} from '../src/experiments/locagent/traces.ts';
import {observe} from '../src/eval/provenance/observations.ts';
const ev=(path='caller.py')=>({snapshotId:'s',revision:'head',path,startLine:1,endLine:4,contentSha256:'a'.repeat(64)});
const finding=(path='caller.py',id='f')=>({id,title:'contract',claim:'concrete claim',trigger:'call',impact:'failure',severity:'high',evidence:[ev(path)]});
function fixture(){
 const entries=[];let n=0,parent=null;
 const append=message=>{const id='e'+(++n);entries.push({type:'message',id,parentId:parent,message});parent=id;return id;};
 const call=(name,args,value,{error=false,raw,details}={})=>{const id='t'+(n+1);append({role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]});append({role:'toolResult',toolCallId:id,toolName:name,isError:error,content:[{type:'text',text:raw??JSON.stringify(value)}],details});return id;};
 const graph=({g0=false,status='ok',path='caller.py',relation='CALLS',direction='upstream',depth=1,resolution='resolved_scoped'}={})=>call(g0?'graph_neighbors':'traverse_graph',g0?{symbolId:'root',direction:'incoming',relation}:{startEntities:['root'],direction,maxHops:depth},{snapshotId:'s',revision:'head',status,items:g0?[{id:'edge',snapshotId:'s',fromId:'caller',toId:'root',relation,resolution,sourcePath:path,sourceLine:1,sourceEndLine:4}]:[{entityId:'caller',path,startLine:1,endLine:4,depth,discoveredVia:{edgeId:'edge',relation,direction,resolution,pathResolved:true}}]});
 const read=(path='caller.py')=>call('read_source',{path,revision:'head',startLine:1,endLine:4},{status:'ok',...ev(path),text:'immutable code'});
 const submit=(findings=[finding()],accepted=true)=>call('submit_review',{findings},{snapshotId:'s',accepted,...(!accepted?{status:'error'}:{})},{error:!accepted});
 const input=(findings=[finding()])=>({runKey:'fixture',snapshotId:'s',findings,jsonl:entries.map(JSON.stringify).join('\n')});
 return {entries,append,call,graph,read,submit,input,analyze:(findings)=>analyzeRetrieval(input(findings))};
}
test('T1 both adapters retain accepted evidence after an SDK failed submit',()=>{
 for(const g0 of [false,true]){const f=fixture();f.graph({g0});f.read();f.call('submit_review',{findings:[]},null,{raw:'Validation failed: missing hash',error:true});f.submit();
 const a=(g0?analyzeTrace:analyzeRetrieval)(f.input());assert.equal(a.findings[0].discoveryPath,'graph_assisted');assert.equal(a.findings[0].strictCallerAssisted,true);assert.equal(a.metrics.submissionAttempts,2);assert.equal(a.metrics.submissionValidationFailures,1);assert.ok(a.traceIssues.every(i=>i.scope==='call'));}
});
test('T2 malformed unrelated Graph A does not poison complete Graph B, classification is per finding',()=>{
 const f=fixture();f.call('traverse_graph',{startEntities:['unrelated']},null,{raw:'failed query',error:true});f.graph();f.read();f.read('text.py');const fs=[finding(),finding('text.py','text'),finding('unread.py','incomplete')];f.submit(fs);const a=f.analyze(fs);
 assert.deepEqual(a.findings.map(f=>f.discoveryPath),['graph_assisted','text_only','ambiguous']);assert.ok(a.findings[2].issues.some(i=>i.scope==='finding'));
});
test('T3 damaged branches and cross-snapshot observations still fail closed',()=>{
 for(const corrupt of [f=>f.entries.push({...f.entries[0]}),f=>f.entries.at(-1).parentId='missing',f=>f.entries[0].parentId=f.entries.at(-1).id,f=>f.entries[1].message.toolCallId='wrong',f=>f.entries[1].message.content[0].text=JSON.stringify({snapshotId:'foreign',status:'ok',items:[]})]){
 const f=fixture();f.graph();f.read();f.submit();corrupt(f);const a=f.analyze();assert.equal(a.findings[0].discoveryPath,'ambiguous');assert.ok(a.traceIssues.some(i=>i.severity==='fatal'));}
});
test('T4 partial definite positive relations get credit with coverage limits in both adapters',()=>{
 for(const g0 of [false,true]){const f=fixture();f.graph({g0,status:'partial'});f.read();f.submit();const a=(g0?analyzeTrace:analyzeRetrieval)(f.input());assert.equal(a.findings[0].discoveryPath,'graph_assisted');assert.equal(a.findings[0].coverageLimited,true);}
 for(const key of ['id','snapshotId']){const f=fixture();f.graph({g0:true,status:'partial'});const page=JSON.parse(f.entries[1].message.content[0].text);delete page.items[0][key];f.entries[1].message.content[0].text=JSON.stringify(page);f.read();f.submit();assert.notEqual(analyzeTrace(f.input()).findings[0].discoveryPath,'graph_assisted');}
});
test('T5 partial empty results supply neither positive nor absence proof',()=>{
 const f=fixture();f.call('traverse_graph',{startEntities:['root']},{snapshotId:'s',status:'partial',items:[]});f.read();f.submit();const a=observe(f.input());assert.equal(a.discoveries.length,0);assert.equal(a.findings[0].discoveryPath,'text_only');assert.equal(a.graphObservations[0].absenceProven,false);assert.equal(a.graphObservations[0].coverageLimited,true);
});
test('T6 search entity credit is distinct from traversal and strict caller credit',()=>{
 const f=fixture();f.call('search_entity',{searchTerms:['caller']},{snapshotId:'s',status:'ok',items:[{entityId:'caller',path:'caller.py',startLine:1,endLine:4}]});f.read();f.submit();const a=f.analyze().findings[0];assert.equal(a.discoveryPath,'graph_assisted');assert.equal(a.entitySearchAssisted,true);assert.equal(a.structuralAssisted,false);assert.equal(a.strictCallerAssisted,false);
});
test('T7 multi-hop, inheritance, import and outgoing calls preserve distinct structural assistance',()=>{
 for(const [config,kind] of [[{depth:2},'multi_hop'],[{relation:'INHERITS'},'inheritance'],[{relation:'IMPORTS'},'import'],[{direction:'downstream'},'outgoing_call']]){const f=fixture();f.graph(config);f.read();f.submit();const a=f.analyze().findings[0];assert.equal(a.structuralAssisted,true);assert.deepEqual(a.assistanceKind,[kind]);assert.equal(a.strictCallerAssisted,false);}
});
test('T8 text or previous Graph hint exposure precludes novel traversal credit',()=>{
 for(const tool of ['search_text','traverse_graph']){const f=fixture();f.call(tool,{},tool==='search_text'?{snapshotId:'s',status:'ok',items:[{path:'caller.py'}]}:{snapshotId:'s',status:'ok',items:[],hints:[{candidates:[{entityId:'caller',path:'caller.py'}]}]});f.graph();f.read();f.submit();assert.notEqual(f.analyze().findings[0].discoveryPath,'graph_assisted');}
});
test('T9 details and private control-plane telemetry never establish discovery',()=>{
 const f=fixture();f.graph();f.entries[1].message.details=JSON.parse(f.entries[1].message.content[0].text);f.entries[1].message.content=[{type:'text',text:'{"snapshotId":"s","status":"ok","items":[]}'}];f.read();f.submit();assert.equal(f.analyze().findings[0].discoveryPath,'text_only');
});
test('T10 abandoned branch discoveries are ignored, and analysis is byte stable',()=>{
 const f=fixture();f.read();f.submit();const parent=f.entries.at(-1).id;f.graph();f.entries.push({type:'custom',id:'leaf',parentId:parent,customType:'routing',data:{path:'caller.py'}});const one=f.analyze(),two=f.analyze();assert.equal(one.findings[0].discoveryPath,'text_only');assert.equal(one.metrics.graphCalls,0);assert.equal(JSON.stringify(one),JSON.stringify(two));
});
test('a correct claim with omitted untouched evidence receives no manufactured credit',()=>{
 const f=fixture();f.graph();f.read();f.read('changed.py');f.submit([finding('changed.py')]);assert.equal(f.analyze([finding('changed.py')]).findings[0].discoveryPath,'text_only');
 const changed=fixture();changed.graph();changed.read();changed.call('read_diff',{path:'caller.py'},{snapshotId:'s',status:'ok',path:'caller.py',lines:['change']});changed.submit();assert.equal(changed.analyze().findings[0].discoveryPath,'text_only');
 const partial=fixture();partial.graph();partial.read();partial.submit();assert.equal(analyzeRetrieval({...partial.input(),changedPaths:['caller.py']}).findings[0].discoveryPath,'text_only');
});

test('invalid tool arguments are recoverable without losing call/result identity',()=>{
 const f=fixture();f.graph();f.read();f.call('submit_review',[],null,{raw:'SDK arguments must be object',error:true});f.submit();const a=f.analyze();
 assert.equal(a.findings[0].discoveryPath,'graph_assisted');assert.equal(a.metrics.submissionAttempts,2);assert.equal(a.metrics.submissionValidationFailures,1);
 assert.ok(a.traceIssues.some(i=>i.kind==='invalid_arguments'&&i.scope==='call'));assert.ok(a.traceIssues.every(i=>i.severity!=='fatal'));
 const dependent=fixture();dependent.graph();dependent.call('read_source',[],{status:'ok',...ev(),text:'contradictory success'});dependent.submit();assert.equal(dependent.analyze().findings[0].discoveryPath,'ambiguous');
});
test('a malformed active native message cannot be silently skipped',()=>{
 const f=fixture();f.append('corrupt message');f.graph();f.read();f.submit();const a=f.analyze();
 assert.equal(a.findings[0].discoveryPath,'ambiguous');assert.ok(a.traceIssues.some(i=>i.kind==='invalid_message'&&i.severity==='fatal'));
});
