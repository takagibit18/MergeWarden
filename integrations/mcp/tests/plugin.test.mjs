import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { configure } from '../../../scripts/codex-plugin.mjs';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
const launcher = fileURLToPath(new URL('../../../scripts/codex-plugin.mjs', import.meta.url));

test('plugin launcher: actual STDIO discovery, no-change task, history and reconnect without a model call', async t => {
  const f = await repositoryFixture(t); const config = join(f.state, 'plugin.json');
  await configure({ repo: f.repository, state: f.state, provider: 'fixture', model: 'offline', 'api-key-env': 'MERGEWARDEN_API_KEY' }, config);
  let diagnostics = '';
  const connect = async () => {
    const client = new Client({ name: 'mergewarden-plugin-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', launcher, 'mcp'],
      env: { ...process.env, MERGEWARDEN_PLUGIN_CONFIG: config, MERGEWARDEN_API_KEY: 'plugin-secret-must-not-appear' }, stderr: 'pipe' });
    transport.stderr?.on('data', data => { diagnostics += data.toString(); });
    t.after(() => client.close()); await client.connect(transport); return client;
  };
  const client = await connect(); const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['cancel_review', 'get_review', 'list_reviews', 'read_evidence', 'start_review']);
  const started = await client.callTool({ name: 'start_review', arguments: { scope: 'commits', base: f.base, head: f.base } });
  assert.ok(started.structuredContent.taskId); let result; const deadline = Date.now() + 15_000;
  do { result = await client.callTool({ name: 'get_review', arguments: { id: started.structuredContent.taskId } }); if (result.structuredContent.done) break; await delay(20); } while (Date.now() < deadline);
  assert.equal(result.structuredContent.status, 'no_changes'); assert.doesNotMatch(JSON.stringify(result), /plugin-secret-must-not-appear/);
  await client.close(); const reconnected = await connect();
  const saved = await reconnected.callTool({ name: 'get_review', arguments: { id: started.structuredContent.taskId } });
  assert.equal(saved.structuredContent.status, 'no_changes');
  const history = await reconnected.callTool({ name: 'list_reviews', arguments: {} }); assert.ok(JSON.stringify(history).includes(started.structuredContent.taskId));
  assert.doesNotMatch(diagnostics, /plugin-secret-must-not-appear/);
});

test('unconfigured plugin fails quickly with no stdout pollution', async t => {
  const f = await repositoryFixture(t);
  await assert.rejects(promisify(execFile)(process.execPath, ['--experimental-strip-types', launcher, 'mcp'],
    { env: { ...process.env, MERGEWARDEN_PLUGIN_CONFIG: join(f.state, 'missing.json') }, windowsHide: true, timeout: 5000 }), error => {
      assert.equal(error.code, 2); assert.equal(error.stdout, ''); assert.match(error.stderr, /Run setup/); return true;
    });
});
