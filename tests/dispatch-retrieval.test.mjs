import test from 'node:test';
import assert from 'node:assert/strict';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {retrieveStructure} from '../src/engine/dispatch-retrieval.ts';
import {ObservedAnchors} from '../src/engine/dispatch-anchors.ts';
function fixture(){
 const symbols=[['module','pkg/__init__.py','file','pkg'],['target','pkg/api.py','function','work'],['consumer','consumer.py','function','consumer'],['wrong','other.py','function','work']].map(([id,path,kind,name])=>({id,path,kind,name,qualifiedName:path+':'+name,snapshotId:'s',startLine:1,endLine:4,startColumn:0,endColumn:0}));
 const relations=[['module','target'],['consumer','target']].map(([fromId,toId],i)=>({id:'e'+i,snapshotId:'s',fromId,toId,relation:'IMPORTS',resolution:'resolved_import_alias',sourcePath:symbols.find(s=>s.id===fromId).path,sourceLine:1,sourceEndLine:1,siteId:'site'+i,resolverVersion:'v4'}));
 return {snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations,sources:{},coverage:{eligibleFiles:4,indexedFiles:4},warnings:[]};
}
test('exact locator rejects fuzzy/filePattern widening and unresolved same-name scopes',()=>{
 const data=fixture();const r=new LocAgentRetrieval(data);
 assert.equal(r.locate({anchors:[{path:'missing.py',name:'work',kind:'function'}]}).anchorStatus,'anchor_missing');
 assert.deepEqual(r.locate({anchors:[{path:'pkg/api.py',name:'work',kind:'function'}]}).items.map(x=>x.entityId),['target']);
 data.symbols.push({...data.symbols[1],id:'nested',qualifiedName:'pkg.api.Other.work'});
 assert.equal(new LocAgentRetrieval(data).locate({anchors:[{path:'pkg/api.py',name:'work',kind:'function'}]}).anchorStatus,'anchor_ambiguous');
});
test('import template follows exports downstream then target consumers upstream',async()=>{
 const r=new LocAgentRetrieval(fixture()),calls=[];
 const request={snapshotId:'s',template:'IMPORT_CHECK',anchors:[{path:'pkg/__init__.py',kind:'file'}]};
 const pack={relations:[],limitations:[],omitted:[],terminal:'no_definite_relation'};
 const items=await retrieveStructure(request,pack,async(name,args)=>{calls.push([name,args]);return name==='locate_entity'?r.locate(args):r.traverse(args)});
 assert.ok(items.some(x=>x.entityId==='consumer'));assert.equal(pack.generationId,'g');
 assert.deepEqual(calls.slice(1).map(c=>c[1].direction),['downstream','upstream']);
 assert.equal(pack.relations.length,2);
});
test('invalid anchors differ from valid zero definite relations and partial positives remain available',async()=>{
 for(const missing of [true,false]){
  const r=new LocAgentRetrieval(fixture()),request={snapshotId:'s',template:'CALLER_CHECK',anchors:[{path:missing?'missing.py':'pkg/api.py',kind:'function',name:'work'}]};
  const pack={relations:[],limitations:[],omitted:[],terminal:'no_definite_relation'};
  await retrieveStructure(request,pack,async(n,a)=>n==='locate_entity'?r.locate(a):r.traverse(a));
  assert.equal(pack.terminal,missing?'anchor_missing':'no_definite_relation');assert.equal(!!pack.anchor,!missing);
 }
 const data=fixture();data.generationState='partial';const r=new LocAgentRetrieval(data);
 const pack={relations:[],limitations:[],omitted:[],terminal:'no_definite_relation'};
 const items=await retrieveStructure({snapshotId:'s',template:'IMPORT_CHECK',anchors:[{path:'pkg/__init__.py',kind:'file'}]},pack,async(n,a)=>n==='locate_entity'?r.locate(a):r.traverse(a));
 assert.ok(items.length);assert.ok(pack.limitations.length);
});
test('escalation uses changed observed ranges, never current-investigation as a query',()=>{
 const a=new ObservedAnchors(['app.py']);
 a.observe({toolName:'read_diff',result:{status:'ok',path:'app.py',offset:0,totalLines:4,lines:['@@ -1,2 +1,2 @@',' def work():','-    return 1','+    return 2']}});
 assert.deepEqual(a.complete({routeType:'STRUCTURAL_ESCALATION',targetHint:'current-investigation'}),[{path:'app.py',startLine:2,endLine:2}]);
 assert.deepEqual(a.complete({routeType:'CALLER_CHECK',reason:'callable_removal'}),[]);
 a.observe({toolName:'read_source',result:{status:'ok',revision:'head',path:'app.py',startLine:1,endLine:100}});
 assert.deepEqual(a.complete({routeType:'STRUCTURAL_ESCALATION'}),[{path:'app.py',startLine:2,endLine:2}]);
});
test('general traversal freezes three hops, inheritance freezes one hop and generation changes fail closed',async()=>{
 for(const template of ['STRUCTURAL_ESCALATION','INHERITANCE_CHECK']){
  const r=new LocAgentRetrieval(fixture()),calls=[],pack={relations:[],limitations:[],omitted:[],terminal:'no_definite_relation'};
  await retrieveStructure({snapshotId:'s',template,anchors:[{path:'pkg/api.py',name:'work',kind:'function'}]},pack,async(n,a)=>{calls.push([n,a]);return n==='locate_entity'?r.locate(a):r.traverse(a)});
  assert.equal(calls[1][1].maxHops,template==='STRUCTURAL_ESCALATION'?3:1);assert.equal(calls[1][1].direction,'both');
 }
 const r=new LocAgentRetrieval(fixture()),pack={relations:[],limitations:[],omitted:[],terminal:'no_definite_relation'};
 await assert.rejects(retrieveStructure({snapshotId:'s',template:'CALLER_CHECK',anchors:[{path:'pkg/api.py',name:'work',kind:'function'}]},pack,async(n,a)=>n==='locate_entity'?r.locate(a):{...r.traverse(a),generationId:'other'}),/generation mismatch/);
});
test('anchor hint overflow never turns the first bounded prefix into a unique anchor',()=>{
 const a=new ObservedAnchors(['app.py']),lines=['@@ -1 +1,40 @@',...Array.from({length:40},(_,i)=>'+value'+i)];
 a.observe({toolName:'read_diff',result:{status:'ok',path:'app.py',offset:0,totalLines:lines.length,lines}});
 assert.deepEqual(a.complete({routeType:'STRUCTURAL_ESCALATION'}),[]);assert.equal(a.limited,true);
});
