import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {planBatch,executeBatch} from '../eval/real/batch.mjs';
const task={case_id:'test',repository:'org/repo',repository_url:'https://github.com/org/repo.git',base_sha:'a'.repeat(40),reviewed_sha:'b'.repeat(40),language:'Python',review_context_policy:'repository'};
test('real batch uses counterbalanced arms and refuses hidden gold',()=>{
 const plan=planBatch([task,{...task,case_id:'next'}],{repeats:2});assert.equal(plan.length,12);assert.deepEqual(plan.slice(3,6).map(j=>j.arm),['G0','G1','T0']);assert.throws(()=>planBatch([{...task,label:'clean'}],{}),/public/);assert.throws(()=>planBatch([task],{selected:['absent']}),/Unknown/);
});
test('resume refuses active owners and validates persisted identity contents',async()=>{
 const output=await mkdtemp(join(tmpdir(),'mw-real-resume-')),plan=planBatch([task],{armNames:['T0']}),identity={corpus:'one'};
 await executeBatch({output,plan,identity,execute:async()=>({status:'completed',delivered:true,findings:[]})});
 await writeFile(join(output,'running.lock'),JSON.stringify({pid:process.pid,hostname:hostname()}));
 await assert.rejects(executeBatch({output,plan,identity,resume:true,execute:async()=>{throw Error('must not run');}}),/still running/);
 const other=await mkdtemp(join(tmpdir(),'mw-real-tamper-'));
 await executeBatch({output:other,plan,identity,execute:async()=>({status:'completed',delivered:true,findings:[]})});
 const file=join(other,'batch.json'),batch=JSON.parse(await readFile(file,'utf8'));batch.identity.corpus='tampered';await writeFile(file,JSON.stringify(batch));
 await assert.rejects(executeBatch({output:other,plan,identity,resume:true,execute:async()=>{throw Error('must not run');}}),/drift/);
});
test('resume retains failed attempt, skips complete attempts, and refuses task drift',async()=>{
 const output=await mkdtemp(join(tmpdir(),'mw-real-batch-')),plan=planBatch([task],{armNames:['T0','G0']});let calls=0;
 await executeBatch({output,plan,identity:{corpus:'a'},execute:async()=>{calls++;return {status:calls===1?'failed':'completed',delivered:calls!==1,findings:[]};}});
 const results=await executeBatch({output,plan,identity:{corpus:'a'},resume:true,execute:async()=>{calls++;return {status:'completed',delivered:true,findings:[]};}});
 assert.equal(calls,3);assert.equal(results[0].attempt,2);assert.equal(JSON.parse(await readFile(join(output,'attempts/test/0/T0/1.json'),'utf8')).status,'failed');
 await assert.rejects(executeBatch({output,plan:planBatch([{...task,reviewed_sha:'c'.repeat(40)}],{armNames:['T0','G0']}),identity:{corpus:'a'},resume:true,execute:async()=>{throw Error('must not run');}}),/drift/);
});
test('formal first-attempt policy never replaces an already started result',async()=>{
 const output=await mkdtemp(join(tmpdir(),'mw-real-first-attempt-')),plan=planBatch([task],{armNames:['T0']}),identity={corpus:'formal',attemptPolicy:'first_attempt'};let calls=0;
 const first=await executeBatch({output,plan,identity,execute:async()=>{calls++;return {status:'partial',delivered:true,findings:[]};}});assert.equal(first[0].attempt,1);assert.equal(first[0].status,'partial');
 const resumed=await executeBatch({output,plan,identity,resume:true,execute:async()=>{calls++;return {status:'completed',delivered:true,findings:[]};}});assert.equal(calls,1);assert.equal(resumed[0].attempt,1);assert.equal(resumed[0].status,'partial');
});
test('a Hot Graph protocol violation is retained and stops the batch immediately',async()=>{
 const output=await mkdtemp(join(tmpdir(),'mw-real-protocol-')),plan=planBatch([task],{armNames:['T0','G0']}),identity={corpus:'protocol'};let calls=0;
 await assert.rejects(executeBatch({output,plan,identity,execute:async()=>{calls++;const error=Error('hot drift');error.code='EXPERIMENT_PROTOCOL_VIOLATION';throw error;}}),/hot drift/);
 assert.equal(calls,1);const latest=JSON.parse(await readFile(join(output,'latest.json'),'utf8'));assert.equal(latest.runs.length,1);assert.equal(latest.runs[0].status,'failed');
});
