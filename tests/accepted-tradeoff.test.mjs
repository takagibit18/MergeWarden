import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { SkillBank } from '../src/skills/bank.ts';
import { feedback, learnPending } from '../src/skills/learning.ts';
import { learningIdentity } from '../src/skills/identity.ts';
import { parseSkillMarkdown, renderSkillMarkdown } from '../src/skills/skill-md.ts';

export const TRADEOFF = `---
name: unguarded-ratio-accepted
description: "Records that ratio() dividing by count without a guard is an accepted legacy trade-off; use when a finding targets that division."
type: accepted_tradeoff
scope: repository_fact
paths: [app.py]
languages: [Python]
keywords: [ratio]
---
# Accept the unguarded ratio division in app.py

## When to use
- A finding reports that ratio divides by count without a guard.

## Procedure
1. Confirm the finding targets the accepted division lines.
2. Check each Still report when condition against the change.

## Not a defect when
- Callers validate count before calling ratio, as the team decided.

## Stop when
- The finding is matched to the accepted lines or to a Still report when condition.

## Still report when
- A new caller passes an unvalidated count.
- The division moves to a code path that handles persisted data.
`;
const sha = text => createHash('sha256').update(text).digest('hex');
const runtime = script => async options => ({ journal: new MemoryJournal(), async prompt(text) { await script(Object.fromEntries(options.tools.map(t => [t.name, t.execute])), options, text); }, async abort() {}, dispose() {}, usage: () => ({ input: 1, output: 1, total: 2 }) });
const finish = async t => { await t.read_diff({ path: 'app.py' }); await t.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [] }); };
export async function fixture(t) {
  const f = await repositoryFixture(t), head = await f.change();
  const options = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' }, evaluation: { tools: 'text-only' }, skills: 'auto', learn: 'auto', skillApproval: 'auto' };
  const run = await new ReviewEngine(runtime(finish)).run(options);
  return { ...f, head, options, run, bank: new SkillBank(f.state) };
}
const addSkill = (markdown, extra = {}) => async input => {
  const identity = learningIdentity(input);
  const op = { op: 'add', targetRef: identity.visible.newTargets[0], sourceRefs: [identity.visible.source.ref], reason: 'Human accepted this trade-off', comparison: [] };
  const result = extra.content ? identity.resolve({ operations: [{ ...op, content: { ...parseSkillMarkdown(markdown).content, dependencyRefs: [], ...extra.content } }] }) : identity.resolve({ operations: [{ ...op, skill: { markdown } }] });
  return { result, requests: 1, usage: null };
};
const learnFeedback = (f, learner) => learnPending(f.state, learner, { model: f.options.model, approval: 'auto', feedbackOnly: true });
export async function acceptTradeoff(f, markdown = TRADEOFF) {
  await feedback(f.state, { runId: f.run.runId, comment: 'Callers validate count; this division is a deliberate trade-off.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'accepted_tradeoff' });
  const [job] = await learnFeedback(f, addSkill(markdown));
  assert.equal(job.status, 'applied', job.error);
  return (await f.bank.skills()).find(s => s.type === 'accepted_tradeoff');
}

test('Still report when parses only as its own section and legacy Skills render without it', () => {
  const { content } = parseSkillMarkdown(TRADEOFF);
  assert.deepEqual(content.stillReportWhen, ['A new caller passes an unvalidated count.', 'The division moves to a code path that handles persisted data.']);
  assert.deepEqual(parseSkillMarkdown(renderSkillMarkdown({ ...content, dependencies: [] })).content, content);
  const legacy = { ...content, type: 'review_procedure' }; delete legacy.stillReportWhen;
  assert.doesNotMatch(renderSkillMarkdown({ ...legacy, dependencies: [] }), /## Still report when/);
  assert.equal(parseSkillMarkdown(TRADEOFF.replace(/## Still report when[\s\S]*$/, '')).content.stillReportWhen, undefined);
});

test('local user accepted_tradeoff feedback creates an active Skill anchored to the exact frozen head lines', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  assert.equal(skill.state, 'active');
  assert.deepEqual(skill.anchor, { path: 'app.py', lineCount: 2, sha256: sha('def ratio(total, count):\n    return total / count') });
  assert.equal(skill.scopeType, 'repository_fact');
});

test('accepted_tradeoff feedback requires a source range', async t => {
  const f = await fixture(t);
  await assert.rejects(feedback(f.state, { runId: f.run.runId, comment: 'Accepted.', verdict: 'accepted_tradeoff' }), /requires --path/);
});

test('run-derived and simulated sources cannot create an accepted trade-off', async t => {
  const f = await fixture(t);
  const [fromRun] = await learnPending(f.state, addSkill(TRADEOFF), { model: f.options.model, approval: 'auto' });
  assert.equal(fromRun.status, 'failed'); assert.match(fromRun.error, /Accepted trade-offs come only from local user/);
  await feedback(f.state, { runId: f.run.runId, comment: 'Simulated acceptance.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'accepted_tradeoff' }, { simulated: true, trustedProjectReviewer: true });
  const [simulated] = await learnFeedback(f, addSkill(TRADEOFF));
  assert.equal(simulated.status, 'failed'); assert.match(simulated.error, /Accepted trade-offs come only from local user/);
  assert.equal((await f.bank.skills()).length, 0);
});

test('a learner cannot supply the anchor', async t => {
  const f = await fixture(t);
  await feedback(f.state, { runId: f.run.runId, comment: 'Accepted trade-off.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'accepted_tradeoff' });
  const [job] = await learnFeedback(f, addSkill(TRADEOFF, { content: { anchor: { path: 'app.py', lineCount: 1, sha256: 'a'.repeat(64) } } }));
  assert.equal(job.status, 'failed'); assert.match(job.error, /anchor is host-recorded/);
});

test('Still report when is required for accepted trade-offs and refused for other types', async t => {
  const f = await fixture(t);
  await feedback(f.state, { runId: f.run.runId, comment: 'Accepted trade-off.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'accepted_tradeoff' });
  const [missing] = await learnFeedback(f, addSkill(TRADEOFF.replace(/## Still report when[\s\S]*$/, '')));
  assert.match(missing.error, /Still report when is required/);
  const [other] = await learnPending(f.state, addSkill(TRADEOFF.replace('type: accepted_tradeoff', 'type: review_procedure')), { model: f.options.model, approval: 'auto', feedbackOnly: true, retryFailed: true });
  assert.match(other.error, /allowed only there/);
  const [method] = await learnPending(f.state, addSkill(TRADEOFF.replace('scope: repository_fact', 'scope: review_method').replace('paths: [app.py]', 'paths: [pkg]')), { model: f.options.model, approval: 'auto', feedbackOnly: true, retryFailed: true });
  assert.match(method.error, /require repository_fact scope/);
});
