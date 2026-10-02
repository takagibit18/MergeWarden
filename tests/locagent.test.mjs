import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SparseIndex,tokenize,fuzzyScore} from '../src/experiments/locagent/sparse.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
const vectors=JSON.parse(await readFile(new URL('./fixtures/locagent/reference-vectors.json',import.meta.url)));
test('LocAgent pinned library differential vectors: tokenizer, BM25 and fuzzy',()=>{
 for(const v of vectors.tokens)assert.deepEqual(tokenize(v.text),v.tokens);
 const index=new SparseIndex(vectors.documents);
 for(const v of vectors.scores){const actual=index.search(v.query);assert.deepEqual(actual.map(r=>r.index),v.results.map(r=>r.index));actual.forEach((r,i)=>assert.ok(Math.abs(r.score-v.results[i].score)<1e-6));}
 for(const v of vectors.fuzzy)assert.ok(Math.abs(fuzzyScore(v.query,v.entity)-v.score)<1e-9);
});
function fixture(){
 const symbols=['a','b','c','d','x'].map((id,i)=>({id,snapshotId:'snap',path:`${id}.py`,qualifiedName:`${id}.${i===4?'a':id}`,name:i===4?'a':id,kind:'function',startLine:1,endLine:2,startColumn:0,endColumn:0}));
 symbols.push({id:'m',snapshotId:'snap',path:'auth/token.py',qualifiedName:'auth.token',name:'token.py',kind:'file',startLine:1,endLine:2,startColumn:0,endColumn:0});
 const relations=[['a','b'],['b','c'],['c','a'],['d','a'],['x','b']].map(([fromId,toId],i)=>({id:`e${i}`,snapshotId:'snap',fromId,toId,relation:'CALLS',resolution:i===4?'candidate':'resolved_scoped',sourcePath:`${fromId}.py`,sourceLine:2,sourceEndLine:2,sourceColumn:0,sourceEndColumn:5,siteId:`s${i}`,resolverVersion:'frozen'}));
 relations.push({...relations[0],id:'duplicate'});
 return {snapshotId:'snap',generationId:'generation-fixture',generationState:'ready',graphScope:'core',symbols,relations,sources:Object.fromEntries(symbols.map(s=>[s.path,`def ${s.name}():\n return "authentication zebra"\n`])),coverage:{eligibleFiles:6,indexedFiles:6,parseIncompleteFiles:0,unsupportedFiles:0,resolvedCalls:4,candidateCalls:1,unresolvedCalls:1},warnings:[]};
}
const walk=(overrides={})=>({startEntities:['a'],direction:'downstream',maxHops:2,entityTypeFilter:[],relationTypeFilter:[],maxNodes:100,...overrides});
test('exact IDs, qualified names, duplicate names and bounded adaptive search',()=>{
 const r=new LocAgentRetrieval(fixture());
 assert.equal(r.search({searchTerms:['a.a'],topK:10}).items[0].matchMode,'exact_id');
 assert.equal(r.search({searchTerms:['a.py:a'],topK:10}).items[0].renderMode,'full');
 const duplicate=r.search({searchTerms:['A'],topK:10});assert.equal(duplicate.items.length,2);assert.ok(duplicate.items.every(i=>i.matchMode==='exact_name'));
 const limited=r.search({searchTerms:['authentication'],topK:1});assert.equal(limited.items.length,1);assert.equal(limited.truncated,true);assert.equal(limited.items[0].renderMode,'fold');
 assert.deepEqual(r.search({searchTerms:['authentication'],topK:3}),r.search({searchTerms:['authentication'],topK:3}));
});
test('BM25 entity/path/content stages, fuzzy last and no-result ablations',()=>{
 const r=new LocAgentRetrieval(fixture());
 assert.ok(r.search({searchTerms:['auth'],topK:10}).items.some(i=>i.matchModes.includes('bm25_entity')));
 assert.ok(r.search({searchTerms:['zebra'],topK:10}).items.every(i=>i.matchModes.includes('bm25_content')));
 assert.equal(r.search({searchTerms:['zzzzqqqq'],topK:10}).items[0].matchMode,'fuzzy');
 assert.equal(new LocAgentRetrieval(fixture(),{fuzzyEnabled:false}).search({searchTerms:['zzzzqqqq'],topK:10}).items.length,0);
 assert.equal(new LocAgentRetrieval(fixture(),{bm25Enabled:false,fuzzyEnabled:false}).search({searchTerms:['auth'],topK:10}).items.length,0);
});
test('controlled DFS: one/two/N hops, directions, cycles, deduplication and filters',()=>{
 const r=new LocAgentRetrieval(fixture());
 assert.deepEqual(r.traverse(walk({maxHops:1})).items.map(i=>i.entityId),['a','b']);
 assert.deepEqual(r.traverse(walk()).items.map(i=>i.entityId),['a','b','c']);
 assert.equal(r.traverse(walk({maxHops:20})).edges.length,3);
 assert.deepEqual(r.traverse(walk({direction:'upstream',maxHops:1})).items.map(i=>i.entityId),['a','c','d']);
 assert.ok(r.traverse(walk({direction:'both',maxHops:1})).tree.includes('CALLS-by'));
 assert.equal(r.traverse(walk({relationTypeFilter:['IMPORTS']})).items.length,1);
 assert.equal(r.traverse(walk({entityTypeFilter:['class']})).items.length,1);
 assert.equal(r.traverse(walk({maxNodes:2})).truncated,true);
 assert.equal(r.traverse(walk({maxBytes:2048})).truncated,true);
 assert.equal(r.traverse(walk({startEntities:['b'],direction:'upstream',maxHops:1})).items.some(i=>i.entityId==='x'),false);
 assert.equal(new LocAgentRetrieval(fixture(),{maxHops:1}).traverse(walk()).maxHops,1);
});
test('snapshot boundary, incomplete coverage, output caps and disabled tools',()=>{
 const data=fixture();data.symbols[0].snapshotId='other';assert.throws(()=>new LocAgentRetrieval(data),/Cross-snapshot/);
 const incomplete=fixture();incomplete.coverage.parseIncompleteFiles=1;
 assert.equal(new LocAgentRetrieval(incomplete,{fuzzyEnabled:false}).search({searchTerms:['zzzzqqqq'],topK:1}).status,'parse_incomplete');
 assert.throws(()=>new LocAgentRetrieval(fixture(),{traverseEnabled:false}).traverse(walk()),/disabled/);
 assert.throws(()=>new LocAgentRetrieval(fixture()).traverse(walk({maxHops:21})),/maxHops/);
});
test('reference invalid traversal root recovery returns BM25 hints without invented edges',()=>{
 const r=new LocAgentRetrieval(fixture());
 const page=r.traverse(walk({startEntities:['auth'],maxBytes:2048}));
 assert.equal(page.status,'ok');assert.equal(page.items.length,0);assert.equal(page.edges.length,0);
 assert.equal(page.hints[0].candidates[0].entityId,'m');assert.equal(page.hints[0].matchMode,'bm25_entity');
 assert.equal(page.coverage.indexedFiles,6);assert.ok(Buffer.byteLength(JSON.stringify(page))<=2048);
 const retry=r.traverse(walk({startEntities:[page.hints[0].candidates[0].entityId]}));assert.equal(retry.items[0].entityId,'m');
});
test('diagnostic-heavy unknown-root responses obey requested byte cap',()=>{
 const data=fixture();data.warnings=Array(10).fill('warning '.repeat(64));
 const result=new LocAgentRetrieval(data).traverse(walk({startEntities:['unknown'],maxBytes:2048}));
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=2048);assert.equal(result.truncated,true);
 assert.equal(result.coverage.indexedFiles,6);
});
test('shared file chunks do not duplicate source per entity and content failure degrades independently',()=>{
 const data=fixture();data.symbols.push({id:'nested',snapshotId:'snap',path:'a.py',qualifiedName:'a.nested',name:'nested',kind:'function',startLine:1,endLine:2,startColumn:0,endColumn:0});
 const normal=new LocAgentRetrieval(data);assert.equal(normal.chunks.length,Object.keys(data.sources).length);assert.equal(normal.search({searchTerms:['nested'],topK:2}).items[0].entityId,'nested');
 const degraded=new LocAgentRetrieval(data,{contentIndexByteLimit:1,fuzzyEnabled:false});assert.equal(degraded.search({searchTerms:['a.a'],topK:2}).items[0].entityId,'a');assert.equal(degraded.traverse(walk({maxHops:1})).items.length,2);
 const missing=degraded.search({searchTerms:['zebra'],topK:2});assert.equal(missing.items.length,0);assert.ok(missing.warnings.some(w=>w.includes('Content retrieval index is unavailable')));
});
test('traversal reaches a node first by a long path then still expands its shorter path',()=>{
 const ids=['a','b','c','d','e'];const symbols=ids.map(id=>({id,snapshotId:'snap',path:`${id}.py`,qualifiedName:id,name:id,kind:'function',startLine:1,endLine:1,startColumn:0,endColumn:1}));
 const pairs=[['a','b'],['b','c'],['c','d'],['a','d'],['d','e'],['a','c']];const relations=pairs.map(([fromId,toId],i)=>({id:`r${i}`,snapshotId:'snap',fromId,toId,relation:'CALLS',resolution:'resolved_scoped',sourcePath:`${fromId}.py`,sourceLine:1,sourceEndLine:1,sourceColumn:0,sourceEndColumn:1,siteId:`site${i}`,resolverVersion:'fixture'}));
 const data={snapshotId:'snap',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations,sources:Object.fromEntries(ids.map(id=>[`${id}.py`,id])),coverage:{eligibleFiles:5,indexedFiles:5,parseIncompleteFiles:0,unsupportedFiles:0},warnings:[]};
 const result=new LocAgentRetrieval(data).traverse(walk({maxHops:3}));assert.ok(result.items.some(item=>item.entityId==='e'));assert.equal(new Set(result.edges.map(edge=>`${edge.fromId}:${edge.toId}`)).size,result.edges.length);
});
