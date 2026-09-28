import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runtimeUrl = new URL('../src/runtime.ts', import.meta.url).href;
const exec = promisify(execFile);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key])=>!['http_proxy','https_proxy','all_proxy','no_proxy','node_use_env_proxy'].includes(key.toLowerCase())));
const listen = server => new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});

test('SDK bootstrap preserves environment proxy routing after Undici import and honors NO_PROXY',async t=>{
  const sockets=new Set();let proxyConnections=0;
  const origin=createServer((_req,res)=>res.end('offline-proxy-fixture'));
  const originPort=await listen(origin);
  const proxy=createServer((req,res)=>{
    assert.equal(req.url,`http://127.0.0.1:${originPort}/`);proxyConnections++;
    const upstream=request({hostname:'127.0.0.1',port:originPort,path:'/',method:req.method},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res);
    });
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  proxy.on('connect',(req,socket,head)=>{
    assert.equal(req.url,`127.0.0.1:${originPort}`);proxyConnections++;sockets.add(socket);
    const upstream=connect(originPort,'127.0.0.1',()=>{
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      socket.pipe(upstream);upstream.pipe(socket);
    });
    sockets.add(upstream);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const proxyPort=await listen(proxy);
  t.after(async()=>{for(const socket of sockets)socket.destroy();origin.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>proxy.close(r))]);});
  const script=`const {createModelRuntime}=await import(${JSON.stringify(runtimeUrl)}); await createModelRuntime(); const r=await fetch('http://127.0.0.1:${originPort}/',{signal:AbortSignal.timeout(5000)}); console.log(await r.text());`;
  const flags=process.allowedNodeEnvironmentFlags.has('--use-env-proxy')?['--use-env-proxy']:[];
  for(const bypass of [false,true]) {
    const {stdout}=await exec(process.execPath,[...flags,'--experimental-strip-types','--input-type=module','-e',script],{
      env:{...cleanEnv(),HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,HTTPS_PROXY:`http://127.0.0.1:${proxyPort}`,NO_PROXY:bypass?'127.0.0.1':''},windowsHide:true,timeout:30_000,
    });
    assert.equal(stdout.trim(),'offline-proxy-fixture');assert.equal(proxyConnections,1);
  }
});

test('SDK network bootstrap preserves explicitly installed fetch instrumentation',async()=>{
  const script=`const {createModelRuntime}=await import(${JSON.stringify(runtimeUrl)});const observer=async()=>{throw Error('offline-only');};globalThis.fetch=observer;await createModelRuntime();if(globalThis.fetch!==observer)throw Error('observer replaced');console.log('preserved');`;
  const {stdout}=await exec(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{env:cleanEnv(),windowsHide:true,timeout:30_000});
  assert.equal(stdout.trim(),'preserved');
});
