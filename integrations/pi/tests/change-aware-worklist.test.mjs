import test from 'node:test';
import assert from 'node:assert/strict';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../src/structural-routing.ts';
import {matchDeclarations} from '../../../src/engine/declarations.ts';
const decl=(name)=>({path:'app.py',scope:'C',name,kind:'method',role:'none',async:false,identity:name,definitionLine:1,range:{startLine:1,endLine:2},signature:'new',body:'b',decorators:'d',structure:'s'});
const changes=['first','second','third'].map(name=>matchDeclarations([{...decl(name),signature:'old'}],[decl(name)],'s')[0]);
async function harness({closeAfter=99,textOnly=false}={}){
 const handlers=new Map(),rows=[],calls=[];let active=TEXT_TOOLS,allowed=true;
 const dispatch={observe(){},providerPayload(){},queued(){},async dispatch(t){calls.push(t);if(calls.length===closeAfter)allowed=false;return {version:'structural-dispatch-2',requestId:t.routeId,terminal:calls.length===1?'anchor_ambiguous':'no_definite_relation',investigations:[],sources:[]};}};
 const routing=createStructuralRouting({snapshotId:'s',changedPaths:['app.py'],declarationChanges:changes,variant:'pi_structural_v2_investigate',textOnly,...(!textOnly?{dispatch}:{}),onBlockedCall(){}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]),()=>allowed);
 routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry:(n,r)=>rows.push(r),getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>active=x,sendMessage(){}});
 await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
 const event={toolName:'read_diff',toolCallId:'d',input:{path:'app.py'},content:[{type:'text',text:JSON.stringify({snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:1,lines:['+change']})}]};
 await handlers.get('tool_result')(event);await handlers.get('tool_result')(event);
 return {routes:rows.at(-1).routes,calls,metrics:routing.metrics()};
}
test('worklist releases the second target after unresolved first; duplicates merge and existing two episode cap applies',async()=>{
 const r=await harness();assert.equal(r.calls.length,2);assert.deepEqual(r.calls.map(t=>t.change.head.name),['first','second']);
 assert.ok(r.routes.every(t=>t.lifecycle==='terminal'));assert.equal(r.routes[0].terminalReason,'ambiguous');assert.equal(r.routes[1].terminalReason,'empty');assert.equal(r.routes[2].terminalReason,'budget_stopped');
});
test('closeout stops pending work without calling Graph or spending its submit reserve',async()=>{
 const r=await harness({closeAfter:1});assert.equal(r.calls.length,1);assert.equal(r.routes[1].terminalReason,'budget_stopped');
});
test('text arm registers identical declaration investigation intents without Graph',async()=>{
 const a=await harness({textOnly:true}),b=await harness();assert.deepEqual(a.routes.map(r=>r.routeId),b.routes.map(r=>r.routeId));assert.equal(a.calls.length,0);assert.equal(a.routes[0].terminalReason,'not_applicable');
});
