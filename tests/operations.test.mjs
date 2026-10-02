import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationGate} from '../src/engine/operations.ts';
test('both origins share atomic admission, settle before a hook enqueues, and cancel queued work',async()=>{
 const abort=new AbortController(),seen=[];
 const gate=new OperationGate({limit:3,signal:abort.signal,available:()=>true,exhausted:()=>abort.abort(Error('budget'))});
 await gate.run('model',async()=>seen.push('trigger'));
 await gate.run('host_dispatch',async()=>seen.push('locate'));
 await gate.run('host_dispatch',async()=>seen.push('source'));
 await assert.rejects(gate.run('model',async()=>seen.push('submit')),/budget/);
 await assert.rejects(gate.run('host_dispatch',async()=>seen.push('extra')),/budget/);
 assert.deepEqual(seen,['trigger','locate','source']);
 assert.equal(gate.counts.model.executed,1);assert.equal(gate.counts.host_dispatch.executed,2);
});
test('cancellation prevents accepted but queued work from starting',async()=>{
 const abort=new AbortController();let release,started=0;
 const gate=new OperationGate({limit:4,signal:abort.signal,available:()=>true,exhausted(){}});
 const a=gate.run('model',()=>new Promise(r=>release=r));await Promise.resolve();
 const b=gate.run('host_dispatch',async()=>started++);abort.abort(Error('cancelled'));release();
 await assert.rejects(a,/cancelled/);await assert.rejects(b,/cancelled/);assert.equal(started,0);
});
