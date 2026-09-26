import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';
import {changeUnits,resolveChangeHints} from '../src/engine/change-resolution.ts';
import {declarationPreview,packInvestigation,packageBytes} from '../src/engine/candidate-catalog.ts';
import {OperationGate} from '../src/engine/operations.ts';
import {EvidenceRegistry} from '../src/application/evidence-registry.ts';
import {emptyCoverage} from '../src/graph/contracts.ts';
const hash=x=>createHash('sha256').update(x).digest('hex');
const symbol=(id,path='app.py',startLine=1,endLine=40)=>({id,snapshotId:'s',path,name:id,qualifiedName:path+':'+id,kind:'function',startLine,endLine,startColumn:0,endColumn:0});
const relation=(fromId,toId,i)=>({id:'edge'+i,snapshotId:'s',fromId,toId,relation:'CALLS',resolution:'resolved_scoped',sourcePath:fromId+'.py',sourceLine:2,sourceEndLine:2,sourceColumn:0,sourceEndColumn:4,siteId:'site'+i,resolverVersion:'v4'});
function fixture({symbols=[symbol('work'),symbol('caller','caller.py'),symbol('second','second.py')],relations=[relation('caller','work',0),relation('second','work',1)],runId='r',snapshotId='s',text,budget}={}){
 const sources=Object.fromEntries(symbols.map(s=>[s.path,`def ${s.name}():\n`+Array.from({length:s.endLine-1},()=>text??'    return 1').join('\n')]));
 const graph=new LocAgentRetrieval({snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations,sources,coverage:{...emptyCoverage(),eligibleFiles:symbols.length,indexedFiles:symbols.length},warnings:[]});
 const abort=new AbortController(),registry=new EvidenceRegistry(snapshotId),events=[],reads=[];
 const gate=new OperationGate({limit:100,signal:abort.signal,available:()=>true,exhausted(){throw Error('budget')}});
 const source=async(path,startLine,endLine)=>{reads.push([path,startLine,endLine]);const text=sources[path].split('\n').slice(startLine-1,endLine).join('\n');return {status:'ok',snapshotId:'s',revision:'head',path,startLine,endLine,text,contentSha256:hash(text)};};
 const service=new ProgressiveInvestigation({runId,snapshotId,changedPaths:['app.py','test.py'],signal:abort.signal,budget,source,promote:s=>registry.register(s),operation:(name,input)=>gate.run('host_dispatch',async()=>name==='resolve_change_units'?graph.resolveChangeUnits(input):name==='host_structural_investigation'?graph.investigate(input):source(input.path,input.startLine,input.endLine))});
 service.setRecorder(e=>events.push(e));
 const observe=(path='app.py',start=1,end=40)=>service.observe({toolName:'read_diff',toolCallId:'diff',input:{path},result:{snapshotId:'s',status:'ok',path,offset:0,totalLines:end-start+2,lines:[`@@ -${start},${end-start+1} +${start},${end-start+1} @@`,...Array.from({length:end-start+1},()=>'+changed')]}});
 const trigger={routeId:'route',routeType:'STRUCTURAL_ESCALATION',targetHint:'work',reason:'search',path:'app.py',toolCallId:'diff',toolName:'read_diff'};
 return {service,graph,registry,gate,abort,events,reads,observe,trigger};
}
test('A/B: forty additions form one unit; separate functions resolve independently and repeated hunks deduplicate',()=>{
 const symbols=[symbol('a','app.py',1,40),symbol('b','app.py',50,80)],anchors=[{path:'app.py',startLine:1,endLine:40},{path:'app.py',startLine:50,endLine:55},{path:'app.py',startLine:60,endLine:65}];
 const result=resolveChangeHints(symbols,'s',anchors),units=changeUnits('s',anchors,result);
 assert.equal(units.length,2);assert.ok(units.every(u=>u.resolution==='resolved'));assert.equal(units[1].changedRanges.length,2);
 const crossed=resolveChangeHints(symbols,'s',[{path:'app.py',startLine:1,endLine:80}]);assert.equal(crossed[0].status,'resolved');assert.equal(crossed[0].items.length,2);
});
test('C: changed-test search before route activation does not replace production diff focus',async()=>{
 const f=fixture();f.observe();f.service.observe({toolName:'search_text',result:{snapshotId:'s',status:'ok',revision:'head',items:[{path:'test.py',line:9}]}});
 const p=await f.service.dispatch(f.trigger);assert.deepEqual(p.investigations[0].changeUnits.map(u=>u.path),['app.py']);assert.equal(p.investigations[0].rootsResolved,1);
});
test('D/E/F: partial ambiguity survives; ambiguous same-name scopes and deletion never fall back',async()=>{
 const f=fixture({symbols:[symbol('a','app.py',1,10),{...symbol('duplicate','app.py',1,10),name:'a'},symbol('work','app.py',20,40),symbol('caller','caller.py')]});
 f.observe('app.py',2,3);f.observe('test.py',1,2);
 const results=resolveChangeHints([symbol('a','app.py',1,10),symbol('b','app.py',1,10),symbol('c','app.py',20,40)],'s',[{path:'app.py',startLine:2,endLine:3},{path:'app.py',startLine:21,endLine:22},{path:'missing.py',name:'a'},{path:'app.py',deleted:true}]);
 assert.deepEqual(results.map(r=>r.status),['ambiguous','resolved','missing','deleted_head_unsupported']);
 f.service.observe({toolName:'read_diff',result:{snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:4,lines:['@@ -2 +2 @@','+a','@@ -21 +21 @@','+b']}});
 const pack=await f.service.dispatch(f.trigger);assert.equal(pack.terminal,'coverage_limited');assert.equal(pack.investigations[0].rootsExplored,1);assert.ok(pack.investigations[0].limitations.some(x=>x.includes('ambiguous')));
});
test('G: multiple roots share 30 nodes / 200 inspections / 200 states',async()=>{
 const roots=Array.from({length:8},(_,i)=>symbol('r'+i,'app.py',i*10+1,i*10+5)),others=Array.from({length:50},(_,i)=>symbol('n'+i,'n'+i+'.py',1,4));
 const f=fixture({symbols:[...roots,...others],relations:roots.flatMap((r,j)=>others.map((s,i)=>relation(s.id,r.id,j*50+i)))});
 const lines=roots.flatMap(r=>[`@@ -${r.startLine} +${r.startLine} @@`,'+change']);f.service.observe({toolName:'read_diff',result:{snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:lines.length,lines}});
 const pack=await f.service.dispatch(f.trigger),inv=pack.investigations[0];assert.equal(inv.rootsResolved,8);assert.ok(inv.rootsOmittedByBudget>0);
 assert.ok(f.service.metrics.visitedNodes<=30);assert.ok(f.service.metrics.edgeInspections<=200);assert.ok(f.service.metrics.expandedStates<=200);
});
test('H/I/J/K: delivered refs only, real source evidence only, cached expansion inside the shared queue',async()=>{
 const f=fixture();f.observe();const pack=await f.service.dispatch(f.trigger),cards=pack.investigations[0].candidateCatalog;
 assert.equal(pack.sources.length,1);assert.equal(cards.length,2);const next=cards[1];
 assert.throws(()=>f.registry.resolve(pack.sources[0].evidenceRefId));await assert.rejects(f.service.expand(next.candidateRefId),/undelivered/);
 f.service.queued(pack);f.service.providerPayload({content:pack.requestId});await assert.rejects(f.service.expand(next.candidateRefId),/undelivered/);
 f.service.providerPayload({content:JSON.stringify(pack)});assert.equal(f.registry.resolve(pack.sources[0].evidenceRefId).path,pack.sources[0].path);
 const page=await Promise.race([f.gate.run('model',()=>f.service.expand(next.candidateRefId)),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('recursive gate deadlock')),1000);t.unref()})]);
 assert.equal(page.contentSha256,hash(page.text));assert.equal(f.registry.resolve(page.evidenceRefId).path,next.entity.path);
 await f.gate.run('model',()=>f.service.expand(next.candidateRefId));assert.equal(f.service.metrics.candidateExpansionReads,1);assert.equal(f.reads.length,2);
 await assert.rejects(f.service.expand('cand_forged'),/Unknown/);await assert.rejects(fixture({runId:'other'}).service.expand(next.candidateRefId),/Unknown/);await assert.rejects(fixture({snapshotId:'other'}).service.expand(next.candidateRefId),/Unknown/);
});
test('L: packing drops previews before source and never slices a hashed page',async()=>{
 const f=fixture();f.observe();const pack=await f.service.dispatch(f.trigger);pack.sources[0].text='x'.repeat(21000);pack.sources[0].contentSha256=hash(pack.sources[0].text);
 for(let i=0;i<20;i++)pack.investigations[0].candidateCatalog.push({...structuredClone(pack.investigations[0].candidateCatalog[0]),candidateRefId:'c'+i,headerPreview:'x'.repeat(512)});
 packInvestigation(pack);assert.ok(packageBytes(pack)<=24576);assert.equal(pack.sources[0].text.length,21000);assert.equal(hash(pack.sources[0].text),pack.sources[0].contentSha256);
 assert.ok(pack.investigations[0].candidateCatalog.every(c=>!c.headerPreview));assert.ok(pack.omittedCandidateCount>0);assert.equal(pack.terminal,'coverage_limited');
});
test('previews contain at most three declaration lines / 512 UTF-8 bytes and no inline body',()=>{
 assert.equal(declarationPreview('def f(x="a:b"): return secret',1,'function'),'def f(x="a:b"):');
 assert.equal(declarationPreview('arbitrary body',1,'file'),undefined);
 assert.ok(Buffer.byteLength(declarationPreview('def f('+ '值'.repeat(500),1,'function'))<=512);
 assert.equal(declarationPreview('def f(\n a,\n b,\n c):\n body',1,'function').split('\n').length,3);
});
test('coalesced named ranges use exact overlap; large batches bound total entity metadata with explicit omissions',()=>{
 const symbols=Array.from({length:100},(_,i)=>symbol('f'+i,'app.py',i*4+1,i*4+3));
 const named=resolveChangeHints(symbols,'s',[{path:'app.py',name:'f50',kind:'function',startLine:1,endLine:400}]);assert.equal(named[0].items[0].entityId,'f50');
 const anchors=Array.from({length:10},(_,i)=>({path:'app.py',startLine:i*40+1,endLine:i*40+40}));
 const result=resolveChangeHints(symbols,'s',anchors);assert.equal(new Set(result.flatMap(r=>r.items.map(e=>e.entityId))).size,32);
 assert.equal(result.reduce((n,r)=>n+(r.omittedItems??0),0),68);assert.ok(changeUnits('s',anchors,result).some(u=>u.provenance.omittedEntityCount));
});
test('delivery and expansion persistence failures poison the investigation; cancellation grants no evidence',async()=>{
 const f=fixture();f.observe();const pack=await f.service.dispatch(f.trigger);f.service.queued(pack);f.service.setRecorder(()=>{throw Error('disk')});
 assert.throws(()=>f.service.providerPayload(JSON.stringify(pack)),/persistence/);f.service.setRecorder(()=>{});assert.throws(()=>f.service.providerPayload(JSON.stringify(pack)),/persistence/);
 assert.throws(()=>f.registry.resolve(pack.sources[0].evidenceRefId));
 const cancelled=fixture();cancelled.observe();cancelled.abort.abort(Error('cancelled'));assert.equal((await cancelled.service.dispatch(cancelled.trigger)).terminal,'cancelled');assert.equal(cancelled.reads.length,0);
});
test('100 replays preserve task, roots, candidates and complete package bytes',async()=>{
 let expected;
 for(let i=0;i<100;i++){const f=fixture();f.observe();const value=JSON.stringify(await f.service.dispatch(f.trigger));expected??=value;assert.equal(value,expected);}
});
