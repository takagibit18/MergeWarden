import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {StructuralDispatch} from '../src/engine/dispatch-service.ts';
import {SnapshotStore} from '../src/snapshot/store.ts';
const out=resolve(process.argv[2]),hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8')),save=(n,v)=>writeFile(join(out,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
assert.equal((await read(join(out,'gate.json'))).pass,true,'Source replay requires candidate gate PASS');
const freeze=await read(join(out,'prediction-freeze.json'));for(const a of freeze.artifacts)assert.equal(hash(await readFile(join(out,a.name))),a.sha256);
const protocol=await read(join(out,'protocol.json')),identities=await read(join(out,'frozen-inputs.json')),selections=await read(join(out,'selection-results.json'));
const input=async suffix=>{const i=identities.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)&&i.role!=='post-freeze scorer only');assert.ok(i);const b=await readFile(i.path);assert.equal(hash(b),i.sha256);return JSON.parse(b);};
const old=await input('/retrieval-v2/b-pattern/results.json'),paths=await input('/path-retention.json'),results=[];
for(const plan of protocol.cases){
 const manifestBytes=await readFile(join(plan.state,'snapshots',plan.snapshotId+'.json'));assert.equal(hash(manifestBytes),plan.snapshotSha256);const store=new SnapshotStore(plan.state,JSON.parse(manifestBytes));
 const baseline=old.find(r=>r.id===plan.id),retained=paths.find(p=>p.id===plan.id).retained,selection=selections.find(s=>s.id===plan.id).armB;
 const chosen=selection.selected.map(s=>s.candidate),selectedIds=new Set(chosen.map(c=>c.terminalEntityId)),edgeIds=new Set(chosen.flatMap(c=>c.retainedPaths.flatMap(p=>p.edgeIds)));
 const edges=[...new Map(retained.states.flatMap(s=>s.predecessorPaths.map(p=>p.edge)).filter(e=>edgeIds.has(e.id)).map(e=>[e.id,e])).values()].sort((a,b)=>a.id<b.id?-1:1);
 const root=baseline.pack.anchor,calls=[],events=[],prefix=[];
 const asDispatch=c=>({...c.terminalEntity,entityId:c.terminalEntityId,depth:c.depth});
 const service=new StructuralDispatch({runId:plan.request.runId,snapshotId:plan.snapshotId,changedPaths:plan.request.changedPaths,signal:new AbortController().signal,promote(){throw Error('No model exposure in source replay');},operation:async(name,input)=>{
   let result;
   if(name==='read_source')result=await store.source(input.revision,input.path,input.startLine,input.endLine);
   else if(name==='locate_entity')result={status:'ok',snapshotId:plan.snapshotId,revision:'head',generationId:plan.generationId,items:[root],anchorStatus:'resolved'};
   else if(name==='traverse_graph')result={status:'ok',snapshotId:plan.snapshotId,revision:'head',generationId:plan.generationId,items:chosen.map(asDispatch),edges};
   else throw Error('Unexpected operation');
   calls.push({name,input,result,mode:name==='read_source'?'immutable_source':'frozen_response_adapter_no_backend'});return result;
 }});service.setRecorder(e=>events.push(e));
 for(const action of plan.actions??[]){const p=action.args,result=action.name==='read_diff'?await store.diff(p.path,p.cursor,p.limit):action.name==='read_source'?await store.source(p.revision,p.path,p.startLine,p.endLine):await store.search(p.revision,p.query,p.limit);prefix.push({name:action.name,input:p,result});service.observe({toolName:action.name,toolCallId:'prefix',input:p,result});}
 if(!plan.actions){const p={revision:'head',path:root.path,startLine:root.startLine,endLine:root.startLine},result=await store.source('head',p.path,p.startLine,p.endLine);prefix.push({name:'read_source',input:p,result});service.observe({toolName:'read_source',toolCallId:'frozen-probe',input:p,result});}
 const pack=await service.dispatch(plan.request);assert.ok(pack);assert.ok(pack.sources.every(s=>selectedIds.has(s.entity.entityId)),'Unselected source delivered');
 assert.ok(calls.filter(c=>c.name==='read_source').length<=3);assert.ok(Buffer.byteLength(JSON.stringify(pack))<=24576);
 for(const source of pack.sources){const r=await store.read(source);assert.equal(r.actualSha256,source.contentSha256);assert.equal(r.text,source.text);assert.ok(source.endLine-source.startLine+1<=80);}
 const candidates=chosen.map(c=>{const source=pack.sources.find(s=>s.entity.entityId===c.terminalEntityId),call=calls.find(x=>x.name==='read_source'&&x.input.path===c.terminalPath&&x.input.startLine>=c.sourceRange.startLine&&x.input.startLine<=c.sourceRange.endLine);return {terminalEntityId:c.terminalEntityId,candidateSelected:true,sourceRead:!!call,sourcePackaged:!!source,sourceRange:call?{path:call.input.path,startLine:call.result.startLine,endLine:call.result.endLine}:null,sourceBytes:call?Buffer.byteLength(call.result.text??''):0,evidenceRefId:source?.evidenceRefId??null};});
 results.push({id:plan.id,candidates,pack,packetBytes:Buffer.byteLength(JSON.stringify(pack)),prefix,calls,events,automaticSourceReads:calls.filter(c=>c.name==='read_source').length,graphBackendRequests:0,realModelCalls:0,modelExposure:false});
 console.log(JSON.stringify({id:plan.id,reads:results.at(-1).automaticSourceReads,packaged:pack.sources.length,bytes:results.at(-1).packetBytes,terminal:pack.terminal}));
}
await save('source-replay.json',results);await save('source-freeze.json',{frozenAt:new Date().toISOString(),sha256:hash(await readFile(join(out,'source-replay.json'))),auditParsed:false});
