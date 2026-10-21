import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { readRun } from '../src/engine/reports.ts';
import { FINAL_REVIEW_DESCRIPTION, INVESTIGATIONS, REVIEW_DECISION_POLICY, REVIEW_DECISION_POLICY_VERSION } from '../src/engine/prompt.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
const observe = seen => async options => ({ journal: new MemoryJournal(), async prompt(text) {
  const tools = Object.fromEntries(options.tools.map(t => [t.name, t]));
  seen.push({ text, submit: tools.submit_review });
  await tools.read_diff.execute({ path: 'app.py' });
  await tools.submit_review.execute({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [] });
}, async abort() {}, dispose() {}, usage: () => ({ input: 1, output: 1, total: 2 }) });

test('investigation off keeps the default prompt, tool contract and policy; safety_fact adds one instruction and rerun inherits it', async t => {
  const f = await repositoryFixture(t), head = await f.change(), seen = [];
  const options = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' }, evaluation: { tools: 'text-only' }, skills: 'off', learn: 'off' };
  const off = await new ReviewEngine(observe(seen)).run(options);
  const on = await new ReviewEngine(observe(seen)).run({ ...options, investigation: 'safety_fact' });
  const rerun = await new ReviewEngine(observe(seen)).run({ ...options, input: undefined, rerunId: on.runId });
  const [plain, variant, inherited] = seen, { prompt, summary } = INVESTIGATIONS.safety_fact;
  assert.doesNotMatch(plain.text, /Safety-fact/);
  assert.equal(plain.submit.description, FINAL_REVIEW_DESCRIPTION);
  assert.equal(variant.text, plain.text.replace('explain the limitation.', 'explain the limitation. ' + prompt));
  assert.equal(variant.submit.description, FINAL_REVIEW_DESCRIPTION + summary);
  assert(variant.submit.schema.properties.summary.description.endsWith(summary));
  assert.equal(inherited.text, variant.text);
  const [m0, m1, m2] = await Promise.all([off, on, rerun].map(r => readRun(f.state, r.runId)));
  assert.equal(m0.investigation, undefined);
  assert.deepEqual(m0.reviewPolicy, { version: REVIEW_DECISION_POLICY_VERSION, sha256: sha(REVIEW_DECISION_POLICY) });
  assert.equal(m1.investigation, 'safety_fact'); assert.equal(m1.reviewPolicy.version, `${REVIEW_DECISION_POLICY_VERSION}+safety_fact`);
  assert.notEqual(m1.reviewPolicy.sha256, m0.reviewPolicy.sha256);
  assert.equal(m2.investigation, 'safety_fact'); assert.deepEqual(m2.reviewPolicy, m1.reviewPolicy);
  await assert.rejects(new ReviewEngine(observe([])).run({ ...options, investigation: 'other' }), /Invalid investigation variant/);
});
