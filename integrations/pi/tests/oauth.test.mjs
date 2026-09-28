import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { createOAuthModelRuntime, createPiRuntimeFactory } from '../src/runtime.ts';
import { loginOAuth, logoutOAuth, oauthStatus } from '../src/auth.ts';
import { oauthLoginError } from '../src/auth-errors.ts';

const provider = 'openai-codex';
const access = `e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline-account'}})).toString('base64')}.fixture-signature`;
const credential = {type:'oauth',access,refresh:'offline-refresh-secret',expires:Date.now()+3_600_000,accountId:'offline-account'};
const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function fixture(t, value) {
  const f = await repositoryFixture(t), authPath = join(f.state,'auth','auth.json');
  await mkdir(join(f.state,'auth'));
  if(value) await writeFile(authPath,JSON.stringify({[provider]:value}));
  return {...f,authPath};
}
function fetchMock(t, fn) {
  const original=globalThis.fetch;
  globalThis.fetch=fn;
  t.after(()=>{globalThis.fetch=original;});
}

test('CLI reads only the explicit app OAuth store in a fresh process and emits metadata only',async t=>{
  const f=await fixture(t,credential),cli=fileURLToPath(new URL('../../../src/cli/main.ts',import.meta.url));
  const {stdout,stderr}=await promisify(execFile)(process.execPath,['--experimental-strip-types',cli,'auth-status','--provider',provider,'--state',f.state,'--repo',f.repository],
    {env:{...process.env,OPENAI_API_KEY:'ambient-secret'},windowsHide:true});
  assert.deepEqual(JSON.parse(stdout),{provider,authentication:'oauth',configured:true,entitlementVerified:false});
  assert.doesNotMatch(stdout+stderr,/ambient-secret|offline-refresh|fixture-signature|offline-account/);
});

test('native Pi device login persists OAuth, status is non-secret/offline and logout removes only that provider',async t=>{
  const f=await fixture(t), calls=[];
  fetchMock(t,async(url,init)=>{
    calls.push(String(url));
    if(String(url).endsWith('/deviceauth/usercode'))return json({device_auth_id:'fixture-device',user_code:'fixture-code',interval:0});
    if(String(url).endsWith('/deviceauth/token'))return json({authorization_code:'fixture-authorization',code_verifier:'fixture-verifier'});
    assert.equal(String(url),'https://auth.openai.com/oauth/token');
    assert.equal(new URLSearchParams(init.body).get('grant_type'),'authorization_code');
    return json({access_token:access,refresh_token:credential.refresh,expires_in:3600});
  });
  const events=[];
  const status=await loginOAuth(provider,f.authPath,{prompt:async prompt=>{assert.equal(prompt.type,'select');return 'device_code';},notify:event=>events.push(event)});
  assert.equal(status.configured,true);assert.equal(status.entitlementVerified,false);
  assert.equal(events[0].type,'device_code');assert.equal(calls.length,3);
  assert.equal(JSON.parse(await readFile(f.authPath,'utf8'))[provider].refresh,credential.refresh);
  globalThis.fetch=async()=>{throw Error('Status must not access the network');};
  assert.deepEqual(await oauthStatus(provider,f.authPath),status);
  assert.doesNotMatch(JSON.stringify(status),/offline-refresh|fixture-signature|offline-account/);
  const stored=JSON.parse(await readFile(f.authPath,'utf8'));stored.other={type:'api_key',key:'other-value'};
  await writeFile(f.authPath,JSON.stringify(stored));
  assert.equal((await logoutOAuth(provider,f.authPath)).configured,false);
  assert.deepEqual(JSON.parse(await readFile(f.authPath,'utf8')),{other:stored.other});
});

test('Pi refresh is serialized across separate runtimes and persists rotated credentials',async t=>{
  const f=await fixture(t,{...credential,expires:1});let refreshes=0;
  fetchMock(t,async(url,init)=>{
    assert.equal(String(url),'https://auth.openai.com/oauth/token');
    const body=new URLSearchParams(init.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),credential.refresh);
    refreshes++;return json({access_token:access,refresh_token:'rotated-fixture-secret',expires_in:3600});
  });
  const a=await createOAuthModelRuntime(provider,f.authPath),b=await createOAuthModelRuntime(provider,f.authPath);
  const auth=await Promise.all([a.getAuth(provider),b.getAuth(provider)]);
  assert.equal(refreshes,1);assert.ok(auth.every(a=>a.auth.apiKey===access));
  assert.equal(JSON.parse(await readFile(f.authPath,'utf8'))[provider].refresh,'rotated-fixture-secret');
});

test('native Pi browser login accepts the matching redirect and exchanges the code',async t=>{
  const f=await fixture(t);let authorize;
  fetchMock(t,async(url,init)=>{
    assert.equal(String(url),'https://auth.openai.com/oauth/token');
    const body=new URLSearchParams(init.body);
    assert.equal(body.get('code'),'fixture-browser-code');
    assert.equal(body.get('redirect_uri'),'http://localhost:1455/auth/callback');
    assert.ok(body.get('code_verifier'));
    return json({access_token:access,refresh_token:credential.refresh,expires_in:3600});
  });
  const result=await loginOAuth(provider,f.authPath,{
    notify(event){if(event.type==='auth_url')authorize=new URL(event.url);},
    async prompt(prompt){
      if(prompt.type==='select')return 'browser';
      assert.equal(prompt.type,'manual_code');assert.equal(authorize.origin,'https://auth.openai.com');
      assert.ok(authorize.searchParams.get('code_challenge'));
      return `http://localhost:1455/auth/callback?code=fixture-browser-code&state=${authorize.searchParams.get('state')}`;
    },
  });
  assert.equal(result.configured,true);
});

test('OAuth rejects missing, wrong-type and corrupt credentials without ambient fallback',async t=>{
  const f=await fixture(t);let calls=0;
  fetchMock(t,async()=>{calls++;throw Error('Unexpected network');});
  await assert.rejects(createOAuthModelRuntime(provider,f.authPath),/login missing/);
  await writeFile(f.authPath,JSON.stringify({[provider]:{type:'api_key',key:'!echo must-not-execute'}}));
  await assert.rejects(createOAuthModelRuntime(provider,f.authPath),/OAuth credential/);
  await writeFile(f.authPath,'{corrupt-secret');
  await assert.rejects(createOAuthModelRuntime(provider,f.authPath),error=>/Cannot read/.test(error.message)&&!error.message.includes('corrupt-secret'));
  assert.equal(calls,0);
});

test('OAuth refresh errors are sanitized and never fall back to another credential',async t=>{
  const f=await fixture(t,{...credential,expires:1});let calls=0;
  fetchMock(t,async()=>{calls++;return new Response('provider-body-secret '+credential.refresh,{status:401});});
  const factory=createPiRuntimeFactory({type:'oauth',authPath:f.authPath});
  await assert.rejects(factory({repositoryPath:f.repository,runDir:f.state,stateDir:f.state,model:{provider,modelId:'gpt-5.4'},tools:[]}),error=>{
    assert.match(error.message,/OAuth authentication or refresh failed/);assert.doesNotMatch(error.message,/provider-body-secret|offline-refresh/);return true;
  });
  assert.equal(calls,1);
});

test('OAuth login errors and cancellation never expose token endpoint bodies',async t=>{
  const f=await fixture(t);
  fetchMock(t,async()=>new Response('provider-body-secret',{status:400}));
  await assert.rejects(loginOAuth(provider,f.authPath,{prompt:async()=> 'device_code',notify(){}}),/^Error: OAuth login failed/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(loginOAuth(provider,f.authPath,{signal:abort.signal,prompt:async()=> 'device_code',notify(){}}),/cancelled or timed out/);
  assert.equal((await oauthStatus(provider,f.authPath)).configured,false);
});

test('OAuth diagnostics classify failures without disclosing token bodies, URLs or unknown error text',()=>{
  for(const [error,code] of [
    [Error('OpenAI Codex token exchange failed (403): access_token=secret-token'), 'token_http_403'],
    [Error('State mismatch'),'state_mismatch'],
    [Error('Missing authorization code'),'missing_code'],
    [new TypeError('fetch failed',{cause:Object.assign(Error('https://secret-user:secret-password@proxy'),{code:'ECONNREFUSED'})}),'network_ECONNREFUSED'],
    [Error('Credential store modify failed for openai-codex',{cause:Error('secret-token')}),'credential_storage'],
    [Error('OpenAI Codex token exchange response missing fields: {"access_token":"secret-token"}'),'invalid_token_response'],
    [Error('https://callback/?code=secret-token'),'unknown'],
  ]) {
    const message=oauthLoginError(error).message;
    assert.ok(message.includes(`[${code}]`),message);
    assert.doesNotMatch(message,/secret-token|secret-user|secret-password|https:\/\//);
  }
});

test('native browser token-exchange rejection reports HTTP status and never saves rejected credentials',async t=>{
  const f=await fixture(t);let authorize;
  fetchMock(t,async()=>new Response('access_token=secret-token',{status:403}));
  await assert.rejects(loginOAuth(provider,f.authPath,{
    notify(event){if(event.type==='auth_url')authorize=new URL(event.url);},
    async prompt(prompt){return prompt.type==='select'?'browser':`http://localhost:1455/auth/callback?code=fixture-code&state=${authorize.searchParams.get('state')}`;},
  }),error=>{assert.match(error.message,/token_http_403/);assert.doesNotMatch(error.message,/secret-token/);return true;});
  assert.equal((await oauthStatus(provider,f.authPath)).configured,false);
});

function response(turn,name,args) {
  const item=name?{type:'function_call',id:`fc_${turn}`,call_id:`call_${turn}`,name,arguments:JSON.stringify(args),status:'completed'}
    :{type:'message',id:`msg_${turn}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.',annotations:[]}]};
  const events=[{type:'response.output_item.added',output_index:0,item}, {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:`resp_${turn}`,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}];
  return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}

test('subscription credentials run the real Pi Codex protocol, tool loop and durable review report offline',async t=>{
  const f=await fixture(t,credential),head=await f.change(),requests=[];
  const originalSocket=globalThis.WebSocket;globalThis.WebSocket=undefined;
  t.after(()=>{globalThis.WebSocket=originalSocket;});
  fetchMock(t,async(url,init)=>{
    const req=new Request(url,init),bytes=Buffer.from(await req.arrayBuffer());
    assert.equal(req.url,'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(req.headers.get('authorization'),`Bearer ${access}`);
    assert.equal(req.headers.get('chatgpt-account-id'),'offline-account');
    const body=JSON.parse((req.headers.get('content-encoding')==='zstd'?zstdDecompressSync(bytes):bytes).toString());requests.push(body);
    if(requests.length===1)return response(1,'read_diff',{path:'app.py'});
    if(requests.length===2)return response(2,'submit_review',{summary:'Synthetic OAuth protocol test only.',reviewedPaths:['app.py'],findings:[]});
    assert.equal(requests.length,3);return response(3);
  });
  const result=await new ReviewEngine(createPiRuntimeFactory({type:'oauth',authPath:f.authPath})).run({repositoryPath:f.repository,stateDir:f.state,
    input:{kind:'commits',base:f.base,head},model:{provider,modelId:'gpt-5.4'},evaluation:{tools:'text-only'}});
  assert.equal(result.report.status,'completed');assert.equal(requests.length,3);
  assert.ok(requests[1].input.some(item=>item.type==='function_call_output'));
  const dir=join(f.state,'runs',result.runId),manifest=JSON.parse(await readFile(join(dir,'run.json'),'utf8')),log=await readFile(join(dir,'session.jsonl'),'utf8');
  assert.equal(manifest.runtimeConfiguration.authentication.type,'oauth');
  assert.equal(manifest.runtimeConfiguration.modelApi,'openai-codex-responses');
  assert.equal(manifest.runtimeConfiguration.inference.requestCount,3);
  assert.match(log,/"role":"toolResult"/);assert.doesNotMatch(log,/offline-refresh-secret|fixture-signature/);
});
