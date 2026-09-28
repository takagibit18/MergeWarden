import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { repositoryFixture } from './repository-fixture.mjs';
const exec=promisify(execFile); const cli=fileURLToPath(new URL('../src/cli/main.ts',import.meta.url));
const run=async(args,env={})=>{try{return {code:0,...await exec(process.execPath,['--experimental-strip-types',cli,...args],{env:{...process.env,...env},windowsHide:true})};}catch(e){return {code:e.code,stdout:e.stdout,stderr:e.stderr};}};

test('CLI help and status identify the real-model gate',async()=>{
  const help=await run(['help']); assert.equal(help.code,0); assert.match(help.stdout,/api-key-env/);
  const status=await run(['status']); const value=JSON.parse(status.stdout); assert.equal(value.liveModelValidated,false); assert.equal(value.liveModelValidation.historical,true); assert.equal(value.liveModelValidation.appliesToCurrentProviderPolicy,false); assert.equal(value.liveModelValidation.provider,'bigmodel'); assert.match(value.liveModelValidation.scope,/timeout/);
});

test('CLI rejects missing explicitly named credentials without starting a model',async t=>{
  const f=await repositoryFixture(t); const result=await run(['review','--repo',f.repository,'--state',f.state,'--base',f.base,'--head',f.base,'--provider','fixture','--model','offline','--api-key-env','MW_TEST_MISSING'],{MW_TEST_MISSING:''});
  assert.equal(result.code,2); assert.match(result.stderr,/Set MW_TEST_MISSING/);
});

test('CLI history starts empty and doctor reports the current environment',async t=>{
  const f=await repositoryFixture(t); const h=await run(['history','--state',f.state]); assert.deepEqual(JSON.parse(h.stdout),[]);
  const d=await run(['doctor','--repo',f.repository,'--state',f.state]); assert.equal(d.code,0); assert.match(JSON.parse(d.stdout).git,/git version/);
});

test('CLI rejects duplicate options without revealing environment key contents',async()=>{
  const result=await run(['review','--model','one','--model','two','--api-key-env','MW_TEST_SECRET'],{MW_TEST_SECRET:'sensitive-fixture-value'});
  assert.equal(result.code,2); assert.match(result.stderr,/Duplicate/); assert.doesNotMatch(result.stdout+result.stderr,/sensitive-fixture-value/);
});

test('CLI rejects ambiguous OAuth and API-key selection before loading Pi',async t=>{
  const f=await repositoryFixture(t);
  const incompatible=await run(['review','--repo',f.repository,'--state',f.state,'--base',f.base,'--head',f.base,'--provider','openai-codex','--model','gpt-5.4','--auth','oauth','--api-key-env','OPENAI_API_KEY']);
  assert.equal(incompatible.code,2);assert.match(incompatible.stderr,/cannot be combined/);
});

test('CLI OAuth login refuses credential state inside the reviewed checkout',async t=>{
  const f=await repositoryFixture(t);
  const result=await run(['auth-status','--provider','openai-codex','--repo',f.repository,'--state',f.repository]);
  assert.equal(result.code,2);assert.match(result.stderr,/outside and separate/);
});
