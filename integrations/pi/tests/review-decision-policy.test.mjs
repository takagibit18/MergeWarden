import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { REVIEW_DECISION_POLICY, REVIEW_DECISION_POLICY_VERSION } from '../../../src/engine/prompt.ts';
import { sha256 } from '../../../src/infrastructure/files.ts';
import { repositoryFixture } from '../../../tests/repository-fixture.mjs';
import { createModelRuntime, createPiRuntime } from '../src/runtime.ts';

for (const graph of [false, true]) test(`shared decision policy reaches native Pi request, tools and persisted run: graph=${graph}`, async t => {
  const f = await repositoryFixture(t, { 'app.py': 'first\nsecond\n' });
  await f.write('app.py', 'changed\nsecond\n'); const head = await f.commit();
  const prior = globalThis.fetch; let requests = 0; let runDir;
  globalThis.fetch = async (url, init) => {
    const body = await new Request(url, init).json(); requests++;
    const messages = body.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    assert.ok(messages.includes(REVIEW_DECISION_POLICY));
    const definitions = Object.fromEntries(body.tools.map(t => [t.function.name, t.function]));
    assert.equal(!!definitions.graph_lookup, graph);
    assert.ok(definitions.search_text.parameters.properties.path);
    assert.ok(definitions.search_text.parameters.properties.cursor);
    assert.match(definitions.submit_review.parameters.properties.summary.description, /empty/);
    const results = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
    let actions = [];
    if (requests === 1) actions = [
      ['read_diff', { path: 'app.py' }],
      ['read_source', { revision: 'head', path: 'app.py', startLine: 1, endLine: 1 }],
      ['search_text', { revision: 'head', path: 'app.py', query: 'second', limit: 1 }],
    ];
    else if (requests === 2) {
      const source = results.find(r => r._mergewarden?.evidenceRefId);
      assert.equal(source.truncated, false); assert.equal(source.hasMoreLines, true);
      const search = results.find(r => Array.isArray(r.items));
      assert.deepEqual(search.items.map(x => [x.path, x.line]), [['app.py', 2]]);
      actions = [['read_source', { revision: 'base', path: 'app.py', startLine: 1, endLine: 2 }]];
    } else if (requests === 3) actions = [['submit_review', { reviewedPaths: ['app.py'], findings: [], summary: 'Synthetic policy-delivery fixture only: read base/head; model judgment is not tested.' }]];
    const delta = actions.length ? { role: 'assistant', tool_calls: actions.map(([name, args], i) => ({ index: i, id: `decision_${requests}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { role: 'assistant', content: 'Fixture complete' };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: actions.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = prior; });
  const model = { provider: 'bigmodel', modelId: 'glm-5.3-flash' };
  const catalog = await createModelRuntime(model.provider, 'offline-key');
  const result = await new ReviewEngine(async options => { runDir = options.runDir; return createPiRuntime(options, catalog, { firstAttemptOnly: true }); }).run({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model, evaluation: { tools: graph ? 'text+graph' : 'text-only' } });
  assert.equal(result.report.status, 'completed'); assert.equal(requests, 4);
  const manifest = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual(manifest.reviewPolicy, { version: REVIEW_DECISION_POLICY_VERSION, sha256: sha256(REVIEW_DECISION_POLICY) });
  assert.ok(manifest.runtimeConfiguration.systemPrompt.includes(REVIEW_DECISION_POLICY));
  const native = await readFile(join(runDir, 'session.jsonl'), 'utf8');
  assert.ok(native.includes('final_batch.accepted')); assert.ok(native.includes('hasMoreLines'));
});
