import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MemoryJournal } from '../../../src/adapters/memory-journal.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { ReviewTasks } from '../src/reviews.ts';
import { createReviewServer } from '../src/server.ts';

export function scriptedRuntime(script) {
  return async options => ({ journal: new MemoryJournal(),
    async prompt(_text, signal) { await script(Object.fromEntries(options.tools.map(tool => [tool.name, tool.execute])), options, signal); },
    async abort() {}, dispose() {}, usage() { return { input: 10, output: 5, total: 15 }; } });
}
export async function submitFinding(tools) {
  await tools.read_diff({ path: 'app.py' });
  const source = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
  await tools.submit_review({ summary: 'Offline synthetic adapter fixture only.', reviewedPaths: ['app.py'], findings: [{
    id: 'division', title: 'Zero division', claim: 'Zero count raises after removing the guard.', trigger: 'count=0', impact: 'request fails', severity: 'high',
    evidence: [{ evidenceRefId: source._mergewarden.evidenceRefId }],
  }] });
}
export async function fixture(t, factory = scriptedRuntime(submitFinding)) {
  let engineFailure; const run = ReviewEngine.prototype.run;
  t.mock.method(ReviewEngine.prototype, 'run', async function (...args) {
    try { return await run.apply(this, args); } catch (error) { engineFailure = error; throw error; }
  });
  const services = [], cleanup = [];
  // Stop all workers and their final receipt writes before the fixture removes state.
  t.after(async () => {
    try { for (const service of services) await service.close(); }
    finally { for (const remove of cleanup) await remove(); }
  });
  const f = await repositoryFixture({ after: remove => cleanup.push(remove) });
  await f.write('app.py', 'def ratio(total, count):\n    return total / count\n'); await f.git('add', 'app.py');
  const host = { repositoryPath: f.repository, stateDir: f.state, model: { provider: 'fixture', modelId: 'offline' }, skills: 'off' };
  const tasks = await ReviewTasks.create(host, factory);
  services.push(tasks);
  return { ...f, host, tasks, get engineFailure() { return engineFailure; }, track(service) { services.push(service); return service; } };
}
export async function connected(t, tasks, era = 'legacy') {
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  const connection = serveStdio(() => createReviewServer(tasks), { transport: serverWire });
  const client = new Client({ name: 'mergewarden-adapter-test', version: '1' },
    { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } });
  await client.connect(clientWire);
  t.after(async () => { await client.close(); await connection.close(); });
  return { client, call: (name, args = {}, options) => client.callTool({ name, arguments: args }, options) };
}
export async function terminal(tasks, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await tasks.get(id);
    if (value.done) return value;
    await delay(10);
  }
  throw Error('Fixture did not reach a terminal native outcome');
}
export async function assertStatus(f, value, expected) {
  if (value.status !== expected) await f.tasks.close();
  assert.equal(value.status, expected, f.engineFailure?.stack);
}
export async function reviewing(tasks, id) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await tasks.get(id, false);
    if (value.progress?.phase === 'reviewing') return value;
    if (value.done) throw Error('Fixture ended before review');
    await delay(10);
  }
  throw Error('Fixture did not enter review');
}
