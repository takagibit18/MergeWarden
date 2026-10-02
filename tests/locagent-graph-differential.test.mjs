import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PythonTreeSitterExtractor} from '../integrations/tree-sitter/src/python-extractor.ts';
import {resolvePython} from '../src/graph/python-resolver.ts';
import {pythonModuleName} from '../src/graph/scope-policy.ts';

const root=new URL('./fixtures/locagent/graph-differential/',import.meta.url);
const paths=['app.py','pkg/__init__.py','pkg/base.py','shadow.py','wild.py'];
const reference=JSON.parse(await readFile(new URL('./fixtures/locagent/graph-reference-4935b557.json',import.meta.url),'utf8'));
const semanticId=entity=>{
 if(entity.kind==='directory')return entity.qualifiedName;
 if(entity.kind==='file')return entity.path;
 const module=pythonModuleName(entity.path),name=entity.qualifiedName.startsWith(`${module}.`)?entity.qualifiedName.slice(module.length+1):entity.qualifiedName;
 return `${entity.path}:${name}`;
};

test('pinned LocAgent graph differential is mapped, adapted or conservatively rejected',async()=>{
 assert.equal(reference.referenceCommit,'4935b557326c154bad8e8dcf3747cc8d32d1f387');assert.equal(reference.builderVersion,'v2.3');assert.deepEqual(reference.classification.pendingDefect,[]);
 const extractor=await PythonTreeSitterExtractor.create();let graph;
 try{const facts=[];for(const path of paths)facts.push(await extractor.extract({snapshotId:'locagent-differential',path,source:await readFile(new URL(path,root),'utf8')}));graph=resolvePython(facts);}finally{extractor.dispose();}
 const byId=new Map(graph.entities.map(entity=>[entity.id,semanticId(entity)]));const nodes=new Map(graph.entities.map(entity=>[semanticId(entity),entity.kind]));
 for(const node of reference.nodes)assert.equal(nodes.get(node.id),node.type,`shared entity ${node.id}`);
 assert.equal(nodes.get('app.py:Child.__init__'),'function');assert.equal(reference.nodes.some(node=>node.id==='app.py:Child.__init__'),false);
 const edges=graph.relations.map(edge=>({from:byId.get(edge.fromId),to:byId.get(edge.toId),type:edge.relation}));const has=(from,to,type)=>edges.some(edge=>edge.from===from&&edge.to===to&&edge.type===type);
 assert.ok(has('app.py:run','pkg/base.py:helper','CALLS'));assert.ok(has('app.py:Child.__init__','pkg/base.py:helper','CALLS'));assert.equal(has('app.py:Child','pkg/base.py:helper','CALLS'),false);
 assert.ok(has('app.py:Child','pkg/base.py:Base','INHERITS'));assert.ok(has('app.py:Child','pkg/base.py:Mixin','INHERITS'));
 assert.equal(has('shadow.py:shadow','pkg/base.py:helper','CALLS'),false);assert.equal(has('wild.py:wild','pkg/base.py:helper','CALLS'),false);
 const calls=graph.facts.flatMap(fact=>fact.calls);assert.equal(calls.find(call=>call.qualifiedName.startsWith('shadow.shadow@')).resolution,'unresolved');assert.equal(calls.find(call=>call.qualifiedName.startsWith('wild.wild@')).resolution,'unresolved');
});
