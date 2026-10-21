import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { ReviewController } from '../src/application/review-controller.ts';
import { readReport, readRun } from '../src/engine/reports.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { freezeSkills } from '../src/skills/context.ts';
import { SkillBank } from '../src/skills/bank.ts';
import { buildInput, feedback, learnPending } from '../src/skills/learning.ts';
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

const catalogOf = text => JSON.parse(text.split('Fallible experience catalog (not source evidence): ')[1]);
/** A later change that leaves the accepted lines untouched, so their anchor is current. */
const laterChange = async f => {
  await f.write('app.py', 'def ratio(total, count):\n    return total / count\n\ndef other():\n    return 1\n');
  return { ...f.options, input: { kind: 'commits', base: f.head, head: await f.commit() }, learn: 'off' };
};
const cite = (skillId, extra = {}) => ({ title: 'ratio divides by an unvalidated count', claim: 'ratio divides by count without a guard.', trigger: 'count=0', impact: 'ZeroDivisionError', severity: 'medium', acceptedTradeoff: { skillId, note: 'No new caller; count is still validated upstream.' }, ...extra });

test('a cited finding on the accepted lines moves to Known and accepted, severe or uncatalogued citations stay reported, and recovery rebuilds the report', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f), journal = new MemoryJournal();
  let receipt;
  const run = await new ReviewEngine(async options => ({ ...await runtime(async (tools, _options, text) => {
    const entry = catalogOf(text).find(e => e.id === skill.id);
    assert.deepEqual(entry.anchor, { path: 'app.py', startLine: 1, endLine: 2 });
    const body = await tools.read_review_skill({ id: skill.id });
    assert.equal(body.format, 'skill-md-2'); assert.match(body.markdown, /## Still report when\n- A new caller passes an unvalidated count\./);
    await tools.read_diff({ path: 'app.py' });
    const page = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 }), evidence = [{ evidenceRefId: page._mergewarden.evidenceRefId }];
    receipt = await tools.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [
      { id: 'folded', ...cite(skill.id), evidence },
      { id: 'severe', ...cite(skill.id, { severity: 'high' }), evidence },
      { id: 'unknown', ...cite('sk_missing', { severity: 'low' }), evidence },
    ] });
  })(options), journal })).run(await laterChange(f));
  assert.deepEqual(receipt.acceptedTradeoffs, [{ id: 'folded', knownAccepted: true }, { id: 'severe', knownAccepted: false, reason: 'Severity high is never folded' }, { id: 'unknown', knownAccepted: false, reason: "Skill sk_missing is not in this run's frozen catalog" }]);
  const report = run.report;
  assert.deepEqual(report.knownAccepted.map(x => [x.id, x.acceptedTradeoff]), [['folded', { skillId: skill.id, revision: skill.revision, note: 'No new caller; count is still validated upstream.' }]]);
  assert.deepEqual(report.findings.map(x => [x.id, x.acceptedTradeoff, x.acceptedTradeoffRejected]), [['severe', undefined, 'Severity high is never folded'], ['unknown', undefined, "Skill sk_missing is not in this run's frozen catalog"]]);
  const md = await readFile(run.markdownPath, 'utf8');
  assert.match(md, /<details><summary>Known and accepted \(1\)<\/summary>/);
  assert.match(md, new RegExp(`Accepted trade-off: Skill ${skill.id} revision ${skill.revision}\.`));
  assert.match(md, /Accepted trade-off not applied: Severity high is never folded/);
  const recovered = new ReviewController(journal, run.runId, report.snapshot); await recovered.restore();
  assert.deepEqual(recovered.report(), report);
  assert.deepEqual(await readReport(f.state, run.runId), report);
});

test('feedback on a Known and accepted finding gives the learner that finding with its citation', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  const run = await new ReviewEngine(runtime(async tools => {
    await tools.read_review_skill({ id: skill.id }); await tools.read_diff({ path: 'app.py' });
    const page = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
    await tools.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [{ id: 'folded', ...cite(skill.id), evidence: [{ evidenceRefId: page._mergewarden.evidenceRefId }] }] });
  })).run(await laterChange(f));
  assert.equal(run.report.knownAccepted.length, 1);
  const { job } = await feedback(f.state, { runId: run.runId, findingId: 'folded', comment: 'Still accepted after this change.' });
  const input = await buildInput(f.state, job.sourceId);
  assert.deepEqual(input.report.findings.map(x => [x.id, x.acceptedTradeoff]), [['folded', { skillId: skill.id, revision: skill.revision, note: 'No new caller; count is still validated upstream.' }]]);
});

test('an uncited or unread accepted trade-off folds nothing', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  const run = await new ReviewEngine(runtime(async tools => {
    await tools.read_diff({ path: 'app.py' });
    const page = await tools.read_source({ revision: 'head', path: 'app.py', startLine: 1, endLine: 2 });
    await tools.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [{ id: 'unread', ...cite(skill.id), evidence: [{ evidenceRefId: page._mergewarden.evidenceRefId }] }] });
  })).run(await laterChange(f));
  assert.equal(run.report.knownAccepted, undefined);
  assert.match(run.report.findings[0].acceptedTradeoffRejected, /was not read in this run/);
});

test('the anchor follows moved lines and becomes recheck once the accepted lines change', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  const entryFor = async (base, head) => { let entry; await new ReviewEngine(runtime(async (tools, _options, text) => { entry = catalogOf(text).find(e => e.id === skill.id); await finish(tools); })).run({ ...f.options, input: { kind: 'commits', base, head }, learn: 'off' }); return entry; };
  await f.write('app.py', 'import os\n\ndef ratio(total, count):\n    return total / count\n'); const moved = await f.commit();
  const shifted = await entryFor(f.head, moved);
  assert.equal(shifted.freshness, 'current'); assert.deepEqual(shifted.anchor, { path: 'app.py', startLine: 3, endLine: 4 });
  await f.write('app.py', 'import os\n\ndef ratio(total, count):\n    return total // count\n'); const edited = await f.commit();
  const stale = await entryFor(moved, edited);
  assert.equal(stale.freshness, 'recheck'); assert.equal(stale.anchor, undefined);
});

test('a copied or relocated instance of the accepted lines does not take over the anchor', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  const entryFor = async head => { let entry; await new ReviewEngine(runtime(async (tools, _options, text) => { entry = catalogOf(text).find(e => e.id === skill.id); await finish(tools); })).run({ ...f.options, input: { kind: 'commits', base: f.head, head }, learn: 'off' }); return entry; };
  const accepted = 'def ratio(total, count):\n    return total / count\n';
  await f.write('app.py', accepted + '\ndef other():\n    return 1\n'); const untouched = await f.commit();
  const unique = await entryFor(untouched);
  assert.equal(unique.freshness, 'current'); assert.deepEqual(unique.anchor, { path: 'app.py', startLine: 1, endLine: 2 });
  await f.write('app.py', accepted + '\n' + accepted); const duplicated = await f.commit();
  const copy = await entryFor(duplicated);
  assert.equal(copy.freshness, 'recheck'); assert.equal(copy.anchor, undefined);
  await f.write('app.py', 'def other():\n    return 1\n\n' + accepted + '# relocated\n'); const relocated = await f.commit();
  const moved = await entryFor(relocated);
  assert.equal(moved.freshness, 'recheck'); assert.equal(moved.anchor, undefined);
});

test('a source failure for one trade-off anchor makes only that Skill recheck', async t => {
  const f = await fixture(t), skill = await acceptTradeoff(f);
  const store = await SnapshotStore.load(f.state, f.run.report.snapshot.id);
  const failing = Object.assign(Object.create(Object.getPrototypeOf(store)), store, { diff: store.diff.bind(store), text: async () => { throw Error('blob unreadable'); } });
  const pkg = await freezeSkills(f.state, failing, 'auto', (await readRun(f.state, f.run.runId)).skills.repositoryKey);
  assert.equal(pkg.degraded, undefined);
  assert.deepEqual(pkg.selected.map(e => [e.skill.id, e.freshness, e.anchor]), [[skill.id, 'recheck', undefined]]);
});
