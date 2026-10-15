import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { encodeFindingId } from '@mergewarden/contracts';
import { MemoryJournal } from '../../../src/adapters/memory-journal.ts';
import { openWorkbench } from '../../../src/composition/workbench.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { launchWorkbench } from '../src/launch.ts';
import { createWorkbenchServer } from '../src/server.ts';
import { assetsFixture, assertError, authenticate, get, ORIGIN } from './helpers.mjs';

// The model response/journal are synthetic test inputs. SnapshotStore,
// ReviewEngine delivery, native files, WorkbenchService and SQLite are real.
async function deliveredFixture(t, findingId = '../中文/%') {
  const f = await repositoryFixture(t);
  await f.write('app.py', 'def ratio(total, count):\n    return total / count\n');
  await f.git('add', 'app.py');
  const runtime = async options => ({
    journal: new MemoryJournal(),
    async prompt() {
      const tools = Object.fromEntries(options.tools.map(tool => [tool.name, tool.execute]));
      await tools.read_diff({ path: 'app.py' });
      const source = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
      await tools.submit_review({ summary: 'Synthetic fixture; no model quality claim.', reviewedPaths: ['app.py'], findings: [{
        id: findingId, title: 'Zero division', claim: 'Zero count raises after guard removal.', trigger: 'count=0', impact: 'request fails', severity: 'high',
        evidence: [{ evidenceRefId: source._mergewarden.evidenceRefId }],
      }] });
    },
    async abort() {}, dispose() {}, usage() { return { input: 10, output: 5, total: 15 }; },
    configuration() { return { systemPrompt: 'private-fixture-runtime-config', thinkingLevel: 'off', modelApi: 'fixture', modelBaseUrl: 'https://provider.invalid', modelMaxTokens: 256 }; },
  });
  const result = await new ReviewEngine(runtime).run({ repositoryPath: f.repository, stateDir: f.state,
    input: { kind: 'staged' }, model: { provider: 'fixture', modelId: 'offline' }, skills: 'off', learn: 'off', timeoutMs: 60_000, maxToolCalls: 10 });
  assert.equal(result.kind, 'report');
  assert.equal(result.report.status, 'completed');
  return { ...f, result, findingId };
}

test('HTTP reads a real SQLite projection, verified native report and frozen source; corruption stays unconfirmed', async t => {
  let service, server;
  t.after(async () => { if (server) await server.close(); else await service?.close(); });
  const f = await deliveredFixture(t);
  const assets = await assetsFixture(t);
  service = await openWorkbench({ repositoryPath: f.repository, stateDir: f.state });
  server = createWorkbenchServer({ service, assetsDir: assets.assetsDir, origin: ORIGIN });
  const cookie = await authenticate(server), runId = f.result.runId;
  const api = `/api/v1/projects/${service.defaultProjectId}`;

  const history = await get(server.app, `${api}/reviews`, cookie);
  assert.equal(history.statusCode, 200, history.body);
  assert.equal(history.json().items.length, 1);
  assert.equal(history.json().items[0].id, runId);
  assert.equal(history.json().items[0].scope, 'staged');
  assert.equal(history.json().items[0].reportAvailability, 'verified');
  const sqlite = await readFile(join(f.state, 'workbench.sqlite'));
  assert.equal(sqlite.subarray(0, 16).toString(), 'SQLite format 3\0');
  assertError(await get(server.app, `${api}/reviews?cursor=not-a-cursor`, cookie), 400, 'INVALID_QUERY');

  const task = await get(server.app, `${api}/tasks/${runId}`, cookie);
  assert.equal(task.statusCode, 200, task.body);
  assert.equal(task.json().done, true);
  assert.equal(task.json().canCancel, false);
  const report = await get(server.app, `${api}/runs/${runId}/report`, cookie);
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().deliveryVerified, true);
  assert.equal(report.json().report.findings[0].id, f.findingId);
  assert.ok(!report.body.includes('private-fixture-runtime-config'));
  assert.ok(!history.body.includes(f.state));

  // Changing the working file cannot alter the evidence retained by this run.
  await f.write('app.py', 'changed after review\n');
  const path = `${api}/runs/${runId}/findings/${encodeFindingId(f.findingId)}/evidence/0`;
  const evidence = await get(server.app, path, cookie);
  assert.equal(evidence.statusCode, 200, evidence.body);
  assert.match(evidence.json().source.text, /return total \/ count/);
  assert.equal(evidence.json().evidence.snapshotId, report.json().report.snapshot.id);
  assert.equal(evidence.json().source.contentSha256, report.json().report.findings[0].evidence[0].contentSha256);

  await writeFile(f.result.reportPath, `${await readFile(f.result.reportPath, 'utf8')} `);
  assertError(await get(server.app, `${api}/runs/${runId}/report`, cookie), 409, 'REPORT_INTEGRITY');
  const corruptTask = await get(server.app, `${api}/tasks/${runId}`, cookie);
  assert.equal(corruptTask.statusCode, 200, corruptTask.body);
  assert.equal(corruptTask.json().done, false);
  assert.equal(corruptTask.json().item.status, null);
  assert.equal(corruptTask.json().item.reportAvailability, 'unavailable');
  assert.equal(corruptTask.json().item.error.code, 'REPORT_INTEGRITY');
  assertError(await get(server.app, path, cookie), 409, 'REPORT_INTEGRITY');
  const invalidated = await get(server.app, `${api}/reviews`, cookie);
  assert.equal(invalidated.statusCode, 200, invalidated.body);
  assert.ok(invalidated.json().sync.skipped >= 1);
  assert.ok(!invalidated.json().items.some(item => item.id === runId && item.reportAvailability === 'verified'));
});

test('actual port-zero loopback launcher serves app and API with a maximal opaque ID over HTTP', async t => {
  let running;
  t.after(async () => { await running?.close(); });
  // JSON encoding of lone surrogates reaches the transport maximum (32,005 chars).
  const findingId = '\ud800'.repeat(4000);
  const f = await deliveredFixture(t, findingId);
  const assets = await assetsFixture(t);
  running = await launchWorkbench({ repositoryPath: f.repository, stateDir: f.state, assetsDir: assets.assetsDir, port: 0 });
  assert.ok(running.port > 0);
  assert.equal(running.app.server.address().address, '127.0.0.1');
  const url = new URL(running.url);
  assert.equal(url.search, '');
  assert.equal(url.pathname, '/');
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const response = await fetch(`${running.origin}/_workbench/session`, { method: 'POST', headers: { origin: running.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 204);
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const page = await fetch(`${running.origin}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Compiled app fixture'));
  const config = await fetch(`${running.origin}/api/v1/config`, { headers: { cookie } });
  assert.equal(config.status, 200);
  const { capabilities, defaultProjectId } = await config.json();
  assert.equal(capabilities.startReview, false);
  const evidence = await fetch(`${running.origin}/api/v1/projects/${defaultProjectId}/runs/${f.result.runId}/findings/${encodeFindingId(findingId)}/evidence/0`, { headers: { cookie } });
  assert.equal(evidence.status, 200, await evidence.clone().text());
  assert.equal((await evidence.json()).findingId, findingId);
  const origin = running.origin;
  await running.close();
  running = undefined;
  await assert.rejects(fetch(origin));
});
