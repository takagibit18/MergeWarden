import test from 'node:test';
import assert from 'node:assert/strict';
import {InvestigationFocus} from '../src/engine/investigation-focus.ts';
const trigger={routeId:'r',routeType:'STRUCTURAL_ESCALATION',path:'app.py',reason:'search',targetHint:'work'};
const diff=(path,lines)=>({toolName:'read_diff',result:{snapshotId:'s',path,status:'ok',offset:0,totalLines:lines.length,lines}});
test('v2 merges 40 changed lines and freezes task independently of later test observations',()=>{
 const f=new InvestigationFocus('s',['app.py','test.py']);
 f.observe(diff('app.py',['@@ -1,40 +1,40 @@',...Array.from({length:40},()=>'+changed')]));
 const focus=f.freeze(trigger);assert.deepEqual(focus.anchors,[{path:'app.py',startLine:1,endLine:40}]);
 f.observe({toolName:'search_text',result:{snapshotId:'s',status:'ok',revision:'head',items:[{path:'test.py',line:9}]}});
 f.observe(diff('test.py',['@@ -1 +1 @@','+test']));assert.deepEqual(f.freeze(trigger),focus);
 focus.anchors[0].path='forged';assert.equal(f.freeze(trigger).anchors[0].path,'app.py');
});
test('v2 bounds ranges without clearing valid work and records deletion-only HEAD limitation',()=>{
 const f=new InvestigationFocus('s',['app.py']);
 f.observe(diff('app.py',Array.from({length:40},(_,i)=>[`@@ -${i*3+1} +${i*3+1} @@`,'+line']).flat()));
 assert.equal(f.freeze(trigger).anchors.length,32);assert.equal(f.freeze(trigger).omitted.length,8);
 const deleted=new InvestigationFocus('s',['app.py']);deleted.observe(diff('app.py',['@@ -1,2 +0,0 @@','-def work():','- pass']));
 assert.equal(deleted.freeze(trigger).anchors[0].deleted,true);
});
test('incomplete, failed and cross-snapshot diff pages cannot establish investigation focus',()=>{
 const f=new InvestigationFocus('s',['app.py']),e=diff('app.py',['@@ -1 +1 @@','+x']);
 f.observe({...e,result:{...e.result,snapshotId:'other'}});assert.equal(f.freeze(trigger).anchors.length,0);
 const g=new InvestigationFocus('s',['app.py']);g.observe({...e,result:{...e.result,totalLines:3}});assert.equal(g.freeze(trigger).anchors.length,0);
});
test('pre-registration requires complete public diff focus and cannot select untouched or stale units',()=>{
 const event=diff('app.py',['@@ -1 +1 @@','+def work():']),unit={snapshotId:'s',path:'app.py',kind:'function',resolution:'resolved',changedRanges:[{startLine:1,endLine:1}],entity:{snapshotId:'s',path:'app.py',kind:'function',name:'work',qualifiedName:'app.work',startLine:1,endLine:3}};
 for(const variant of [unit,{...unit,snapshotId:'old'},{...unit,path:'hidden.py'},{...unit,changedRanges:[{startLine:2,endLine:2}]}]){
  const f=new InvestigationFocus('s',['app.py']);if(variant!==unit)f.observe(event);assert.throws(()=>f.register(trigger,variant),/complete observed/);
 }
 const f=new InvestigationFocus('s',['app.py']);f.observe(event);f.register(trigger,unit);
 assert.deepEqual(f.freeze(trigger).anchors,[{path:'app.py',kind:'function',name:'work',qualifiedName:'app.work',startLine:1,endLine:3}]);
 assert.throws(()=>f.register(trigger,unit));
});
