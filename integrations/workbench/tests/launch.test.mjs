import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';

test('foreground CLI prints actual URL without credentials and shuts down on SIGTERM', async t => {
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await once(child, 'exit');
    }
  });
  const f = await repositoryFixture(t);
  // Windows cannot deliver a graceful SIGTERM via child.kill. A controlled test
  // import forwards IPC to the same real process signal handler and disconnects.
  const bridge = join(f.directory, 'signal-bridge.mjs');
  await writeFile(bridge, "process.on('message', message => { if (message === 'shutdown') { process.emit('SIGTERM'); process.disconnect(); } });\n");
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  child = spawn(process.execPath, ['--import', pathToFileURL(bridge).href, '--experimental-strip-types', entry, '--repo', f.repository, '--state', f.state, '--port', '0'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { stdout += text; });
  child.stderr.on('data', text => { stderr += text; });
  const startup = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error('Workbench CLI did not print its startup URL.')), 15_000);
    child.stdout.on('data', () => {
      const match = stdout.match(/MergeWarden Workbench: (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43})/);
      if (match) { clearTimeout(timer); resolveReady(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Workbench CLI exited before becoming ready.')); });
  });
  const launch = new URL(await startup), origin = launch.origin;
  const token = new URLSearchParams(launch.hash.slice(1)).get('token');
  const session = await fetch(`${origin}/_workbench/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(session.status, 204);
  const cookie = session.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(`${origin}/api/v1/config`, { headers: { cookie } })).status, 200);
  const exited = once(child, 'exit');
  child.send('shutdown');
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.ok(!stderr.includes(token));
  await assert.rejects(fetch(origin));
});
