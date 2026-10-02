import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveChangeHints} from '../src/engine/change-resolution.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {emptyCoverage} from '../src/graph/contracts.ts';
const s=(id,kind,parentSymbolId)=>({id,kind,parentSymbolId,name:id,qualifiedName:'app.'+id,snapshotId:'s',path:'app.py',startLine:1,endLine:10,startColumn:0,endColumn:0});
const relation=(fromId,toId,kind)=>({id:fromId+toId+kind,snapshotId:'s',fromId,toId,relation:kind,resolution:'resolved_scoped',sourcePath:'app.py',sourceLine:1,sourceEndLine:1,sourceColumn:0,sourceEndColumn:1,siteId:'site',resolverVersion:'v4'});
test('typed constructor bridge retains constructor class and exact incoming relation; ordinary methods do not climb containment',()=>{
 const symbols=[s('C','class'),{...s('init','function','C'),name:'__init__',functionKind:'method'},s('f','function','C'),s('caller','function')];
 const relations=[relation('C','init','CONTAINS'),relation('C','f','CONTAINS'),relation('caller','C','CALLS')];
 const graph=new LocAgentRetrieval({snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations,sources:{},coverage:emptyCoverage(),warnings:[]});
 const context={snapshotId:'s',generationId:'g',route:'CALLER_CHECK',changedPaths:['app.py'],visibleRanges:[]};
 const a=graph.investigate({roots:['init'],route:'CALLER_CHECK',changeAware:true,context});
 assert.deepEqual(a.pool.eligible[0].retainedPaths[0].entityIds,['init','C','caller']);
 assert.equal(graph.investigate({roots:['f'],route:'CALLER_CHECK',changeAware:true,context}).pool.eligible.length,0);
});
test('import resolver starts with one binding definition, refuses wildcard, and never returns package root',()=>{
 const target={...s('Bar','class'),path:'pkg/foo.py',qualifiedName:'pkg.foo.Bar'};
 const declaration={head:{importItem:{module:'pkg.foo',importedName:'Bar',localBinding:'Baz',relativeLevel:0,uncertain:false}},match:'matched'};
 const hint={path:'pkg/__init__.py',declaration};
 assert.equal(resolveChangeHints([target,s('pkg','file')],'s',[hint])[0].items[0].entityId,'Bar');
 declaration.head.importItem.uncertain=true;assert.equal(resolveChangeHints([target],'s',[hint])[0].status,'ambiguous');
});
