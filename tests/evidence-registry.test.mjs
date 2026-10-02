import test from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceRegistry,evidenceRefId} from '../src/application/evidence-registry.ts';
import {ReviewEngine} from '../src/engine/review.ts';
import {MemoryJournal} from '../src/adapters/memory-journal.ts';
import {repositoryFixture} from './repository-fixture.mjs';
const ref={snapshotId:'s',revision:'head',path:'app.py',startLine:1,endLine:2,contentSha256:'a'.repeat(64)};
const finding=evidence=>({id:'f',title:'zero',claim:'division fails',trigger:'count=0',impact:'exception',severity:'high',evidence});
test('stable IDs use all immutable identity fields, isolate registry ownership and copies',()=>{
 const registry=new EvidenceRegistry('s'),id=registry.register(ref);assert.equal(id,registry.register({...ref}));assert.equal(id,evidenceRefId(ref));
 for(const patch of [{snapshotId:'other'},{revision:'base'},{path:'other.py'},{startLine:2},{endLine:3},{contentSha256:'b'.repeat(64)}])assert.notEqual(id,evidenceRefId({...ref,...patch}));
 assert.throws(()=>new EvidenceRegistry('s').resolve(id),/Unknown/);assert.throws(()=>new EvidenceRegistry('other').register(ref),/snapshot/);
 const copy=registry.resolve(id);copy.path='mutated';assert.equal(registry.resolve(id).path,'app.py');
});
test('normalization preserves explicit choice, legacy references and deterministic deduplication',()=>{
 const registry=new EvidenceRegistry('s'),id=registry.register(ref);
 assert.deepEqual(registry.normalize([finding([{evidenceRefId:id},ref,{evidenceRefId:id}])]),[finding([ref])]);
 assert.throws(()=>registry.normalize([finding([{evidenceRefId:'ev_missing'}])]),/Unknown/);
 assert.throws(()=>registry.normalize([finding([{evidenceRefId:id,path:'wrong'}])]),/only evidenceRefId/);
});
test('Engine resolves IDs before mutation, rejects foreign/unread references, and delivers full refs only',async t=>{
 const f=await repositoryFixture(t),head=await f.change(),journal=new MemoryJournal();let expected;
 const result=await new ReviewEngine(async options=>({journal,abort:async()=>{},dispose(){},usage:()=>({input:1,output:1,total:2}),async prompt(){
  const tools=Object.fromEntries(options.tools.map(t=>[t.name,t.execute]));await tools.read_diff({path:'app.py'});
  const source=await tools.read_source({path:'app.py',revision:'head',startLine:1,endLine:2});const id=source._mergewarden.evidenceRefId;
  expected=Object.fromEntries(Object.keys(ref).map(k=>[k,source[k]]));
  const baseline=JSON.stringify(await journal.readActiveBranch());
  const submit=findings=>tools.submit_review({summary:'Fixture',reviewedPaths:['app.py'],findings});
  for(const evidence of [[{evidenceRefId:'ev_missing'}],[{...expected,snapshotId:'foreign'}],[{evidenceRefId:evidenceRefId({...expected,revision:'base'})}]]){
   await assert.rejects(submit([finding([{evidenceRefId:id}]),{...finding(evidence),id:'second'}]));
   assert.equal(JSON.stringify(await journal.readActiveBranch()),baseline);
  }
  await submit([finding([{evidenceRefId:id},expected,{evidenceRefId:id}])]);
 }})).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools:'text-only'}});
 assert.equal(result.report.status,'completed');assert.deepEqual(result.report.findings,[finding([expected])]);assert.doesNotMatch(JSON.stringify(result.report),/evidenceRefId/);
});
