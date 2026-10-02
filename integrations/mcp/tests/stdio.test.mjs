import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { ReviewTasks } from '../src/reviews.ts';

for (const era of ['legacy', 'modern']) test(`production STDIO ${era}: discovery, no_changes and persisted reconnect`, async t => {
  const f = await repositoryFixture(t);
  const client = new Client({ name: 'mergewarden-stdio-test', version: '1' }, { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-strip-types', fileURLToPath(new URL('../src/main.ts', import.meta.url)), '--repo', f.repository, '--state', f.state,
      '--provider', 'fixture', '--model', 'offline', '--api-key-env', 'MERGEWARDEN_MCP_TEST_KEY'],
    env: { MERGEWARDEN_MCP_TEST_KEY: 'never-return-this-secret' }, stderr: 'pipe' });
  let diagnostics = ''; transport.stderr?.on('data', data => { diagnostics += data.toString(); });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), era); assert.equal((await client.listTools()).tools.length, 5);
  const started = await client.callTool({ name: 'start_review', arguments: { scope: 'commits', base: f.base, head: f.base } });
  assert.ok(started.structuredContent.taskId); const deadline = Date.now() + 15_000;
  let done;
  while (Date.now() < deadline) {
    done = await client.callTool({ name: 'get_review', arguments: { id: started.structuredContent.taskId } });
    if (done.structuredContent?.done) break;
    await delay(20);
  }
  assert.equal(done.structuredContent.status, 'no_changes'); assert.doesNotMatch(JSON.stringify(done), /never-return-this-secret/);
  assert.doesNotMatch(diagnostics, /never-return-this-secret/);
  await client.close();
  const tasks = await ReviewTasks.create({ repositoryPath: f.repository, stateDir: f.state, model: { provider: 'fixture', modelId: 'offline' } }, async () => { throw Error('must not start'); });
  t.after(() => tasks.close());
  assert.equal((await tasks.get(started.structuredContent.taskId)).status, 'no_changes');
});
