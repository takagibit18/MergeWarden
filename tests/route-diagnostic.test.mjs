import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {save,hash} from '../eval/candidate-dataset-context.mjs';
import {replayRoute} from '../eval/route-diagnostic-replay.mjs';
import {createFeatureExtractor,diffFragments} from '../eval/route-observable-features.mjs';
const lines=['--- a/app.py','+++ b/app.py','@@ -1,2 +1,2 @@','-def work(a):','+def work(a, b=2):','     return a'];
test('route-only replay reproduces current signature trigger and stops before any future input',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'route-only-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'prefix.json');
  await save(path,{blocks:[{tool:'read_diff',toolCallId:'d',input:{path:'app.py'},result:{snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:lines.length,lines}}, {tool:'traverse_graph',result:{snapshotId:'s'}}]});
  const plan={caseId:'fixture',snapshotId:'s',changedPaths:['app.py'],prefixPath:path};const a=await replayRoute(plan),b=await replayRoute(plan);
  assert.equal(a.events.length,1);assert.equal(a.routeTriggered,true);assert.equal(a.graphRequests,0);assert.equal(a.routeReasons[0],'signature_change');assert.equal(a.triggerOrdinal,1);assert.equal(hash(a),hash(b));
  assert.equal((await replayRoute({...plan,historicalExpected:a.summary})).historicalMatch,true);assert.equal((await replayRoute({...plan,historicalExpected:{triggered:0}})).historicalMatch,false);
});
const replayFor=lines=>({events:[],detectorInputs:[{path:'app.py',lines}],detectedSignals:[],currentSearchCount:0,checkpoints:[{pages:{}}]});
test('visible Python CST extracts multiline signatures, argument forwarding and annotation independently',async()=>{
  const extractor=await createFeatureExtractor();try{
    const p={caseId:'synthetic',changedPaths:['app.py'],prefixKind:'test'},r=replayFor(['@@ -1,4 +1,4 @@','-def work(','-    a=1,','-) -> int:','-    return helper(a)','+def work(','+    a=2,','+) -> str:','+    return helper(a + 1)']);
    const a=extractor.extract(r,p);assert.equal(a.structural.functionSignatureChanged,1);assert.equal(a.structural.returnAnnotationChanged,1);assert.equal(a.interaction.argumentForwardingChanged,true);assert.equal(a.structural.defaultValueChanged,true);assert.equal(a.structural.configLookupChanged,null);assert.equal(hash(a),hash(extractor.extract(r,p)));
    const unchanged=extractor.extract(replayFor(['@@ -1,3 +1,3 @@',' def work():','     helper(1)','     helper(2)']),p);assert.equal(unchanged.interaction.argumentForwardingChanged,false);
    const assignment=extractor.extract(replayFor(['@@ -1,1 +1,2 @@',' x = 1','+y = 2']),p);assert.equal(assignment.structural.__all__Changed,false);
    const exports=extractor.extract(replayFor(['@@ -1,1 +1,1 @@','-__all__ = ["a"]','+__all__ = ["b"]']),p);assert.equal(exports.structural.__all__Changed,true);
  }finally{extractor.close();}
});
test('CST features ignore comment/string decoys and preserve unavailable scope',async()=>{
  const extractor=await createFeatureExtractor();try{
    const f=extractor.extract(replayFor(['@@ -1,2 +1,2 @@','-# return None','-x = "if isinstance(a, B): raise Failure"','+# return [a]','+x = "for x in values: helper(x)"']),{caseId:'decoy',changedPaths:['app.py']});
    assert.equal(f.structural.callAdded,0);assert.equal(f.behavioral.newTypeCheck,0);assert.equal(f.behavioral.iterationShapeChange,false);assert.equal(f.structural.returnShapeChanged,false);
    assert.deepEqual(diffFragments('a.py',lines)[0].added,[1]);
  }finally{extractor.close();}
});
