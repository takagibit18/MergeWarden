import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModelRuntime, createPiRuntime } from '../../pi/src/runtime.ts';
import { assertStatus, connected, fixture, terminal } from './helpers.mjs';

const { createAssistantMessageEventStream } = await import(new URL('../../pi/node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.url).href);

for (const fault of [false, true]) test(`MCP uses the real Pi tool loop and durable journal${fault ? ' with a publication fault' : ''}`, async t => {
  const catalog = await createModelRuntime('fixture', 'offline-adapter-secret');
  let turn = 0, runDir;
  const visible = context => context.messages.filter(message => message.role === 'toolResult').flatMap(message => {
    try { return [JSON.parse(message.content[0].text)]; } catch { return []; }
  });
  catalog.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'https://offline.invalid', apiKey: 'offline-adapter-secret',
    models: [{ id: 'offline', name: 'offline', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2048 }],
    streamSimple(model, context) {
      turn++;
      const source = visible(context).find(page => page.path === 'app.py' && page._mergewarden?.evidenceRefId);
      const action = turn === 1 ? { name: 'read_diff', arguments: { path: 'app.py' } }
        : turn === 2 ? { name: 'read_source', arguments: { revision: 'head', path: 'app.py', startLine: 1, endLine: 2 } }
        : turn === 3 ? { name: 'submit_review', arguments: { summary: 'Scripted real Pi SDK plumbing only.', reviewedPaths: ['app.py'], findings: [{
          id: 'division', title: 'Zero division', claim: 'Removing the guard makes count=0 raise.', trigger: 'count=0', impact: 'exception', severity: 'high',
          evidence: [{ evidenceRefId: source._mergewarden.evidenceRefId }],
        }] } } : undefined;
      const content = action ? [{ type: 'toolCall', id: `mcp-pi-${turn}`, ...action }] : [{ type: 'text', text: 'Done' }];
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(),
        stopReason: action ? 'toolUse' : 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); });
      return stream;
    },
  });
  const f = await fixture(t, async options => {
    runDir = options.runDir;
    const runtime = await createPiRuntime(options, catalog);
    if (fault) {
      const append = runtime.journal.append.bind(runtime.journal);
      runtime.journal.append = async event => { if (event.payload.type === 'final_batch.accepted') throw Error('Injected journal acknowledgement failure with offline-adapter-secret'); await append(event); };
    }
    return runtime;
  });
  const { call } = await connected(t, f.tasks, 'modern');
  const { taskId } = (await call('start_review')).structuredContent;
  const done = await terminal(f.tasks, taskId);
  await assertStatus(f, done, fault ? 'delivery_failed' : 'completed');
  assert.doesNotMatch(JSON.stringify(done), /offline-adapter-secret/);
  const rows = (await readFile(join(runDir, 'session.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'custom' && row.data?.payload?.type === 'run.started'));
  assert.equal(rows.filter(row => row.type === 'custom' && row.data?.payload?.type === 'final_batch.accepted').length, fault ? 0 : 1);
  if (fault) assert.equal(done.report, undefined);
  else {
    assert.ok(turn >= 4);
    const evidence = await call('read_evidence', { runId: done.runId, findingId: done.report.findings[0].id });
    assert.match(evidence.structuredContent.source.text, /return total \/ count/);
    assert.equal(done.report.findings.length, 1);
  }
});
