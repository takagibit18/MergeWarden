import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { SkillBank, digest } from '../src/skills/bank.ts';
import { feedback, learnPending, buildInput } from '../src/skills/learning.ts';
import { freezeSkills } from '../src/skills/context.ts';
import { learningIdentity } from '../src/skills/identity.ts';
import { normalizeContent, similarity, SIMILARITY_POLICY } from '../src/skills/normalize.ts';
import { viewProposal, formatProposal } from '../src/skills/proposal-view.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';

const procedure = { type: 'review_procedure', title: 'Check denominator contract at call boundaries',
  conditions: ['When the denominator is an optional input.'],
  steps: ['Read the caller and distinguish omitted values from explicit zero.', 'Inspect division and test whether a guard handles the actual input.'],
  counterexamples: ['A validated positive count excludes zero.'], stopConditions: ['Stop when callers and guards establish the allowed range.'],
  paths: ['app.py'], languages: ['Python'], keywords: ['count'], dependencies: [] };
const unrelated = { type: 'review_procedure', title: 'Check cache invalidation after configuration reload',
  conditions: ['When a reload path replaces configuration objects held by a cache.'],
  steps: ['Find every cache keyed by configuration identity.', 'Confirm the reload path clears or rekeys those caches.'],
  counterexamples: ['Caches keyed by immutable content hashes survive reloads safely.'], stopConditions: ['Stop when every cache consumer is accounted for.'],
  paths: ['app.py'], languages: ['Python'], keywords: ['reload'], dependencies: [] };
const runtime = script => async options => ({ journal: new MemoryJournal(), async prompt(text, signal) { await script(Object.fromEntries(options.tools.map(t => [t.name, t.execute])), options, text, signal); }, async abort() {}, dispose() {}, usage: () => ({ input: 1, output: 1, total: 2 }) });
const finish = async t => { await t.read_diff({ path: 'app.py' }); await t.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [] }); };
async function fixture(t) {
  const f = await repositoryFixture(t), head = await f.change();
  const options = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' }, evaluation: { tools: 'text-only' }, skills: 'auto', learn: 'auto' };
  const run = await new ReviewEngine(runtime(finish)).run(options);
  return { ...f, options, run, bank: new SkillBank(f.state) };
}
const compare = (input, target, relation = 'same') => (input.existingSkills?.catalog ?? []).map(c => ({ id: c.id, revision: c.revision, relation: c.id === target ? relation : 'distinct', note: c.id === target ? 'Same checking behaviour' : 'Different checking behaviour' }));
const learner = transform => async input => ({ result: transform(input), usage: null, requests: 1 });
const add = (id, content) => learner(input => ({ operations: [{ op: 'add', id, expectedRevision: 0, sourceIds: [input.source.id], reason: 'Conditional method from frozen source', content, comparison: compare(input) }] }));
const learn = (f, l, extra = {}) => learnPending(f.state, l, { model: f.options.model, ...extra });
const jobFile = async (f, id) => JSON.parse(await readFile(join(f.state, 'skills', 'jobs', id + '.json'), 'utf8'));

test('learned changes are staged; reviews and the bank ignore them until a person approves', async t => {
  const f = await fixture(t);
  const [job] = await learn(f, add('sk_denominator', procedure));
  assert.equal(job.status, 'proposed'); assert.match(job.proposalId, /^pr_[a-f0-9]{24}$/);
  assert.deepEqual(await f.bank.skills(), []);
  const store = await SnapshotStore.load(f.state, f.run.report.snapshot.id);
  assert.equal((await freezeSkills(f.state, store, 'auto', store.manifest.identity.repositoryId)).selected.length, 0);
  const [pending] = (await f.bank.proposals()).filter(p => p.status === 'pending');
  const view = await viewProposal(f.bank, pending);
  assert.deepEqual(view.changes.map(c => [c.op, c.id, c.revision.to, c.state.to]), [['add', 'sk_denominator', 1, 'trial']]);
  assert.match(formatProposal(view), /ADD sk_denominator {2}r0 → r1/);
  const receipt = await f.bank.approve(job.proposalId, { by: 'local_user', at: new Date().toISOString(), note: 'Matches team convention' });
  assert.equal(receipt.outcome, 'applied');
  assert.deepEqual((await f.bank.skills()).map(s => [s.id, s.state]), [['sk_denominator', 'trial']]);
  assert.equal((await f.bank.proposal(job.proposalId)).decision.note, 'Matches team convention');
  await assert.rejects(f.bank.approve(job.proposalId, { by: 'local_user', at: new Date().toISOString() }), /already approved/);
  assert.deepEqual(await learn(f, async () => { throw Error('must not extract again'); }), []);
  assert.equal((await jobFile(f, job.id)).status, 'applied');
});

test('rejection publishes nothing; a proposal overtaken by another change becomes stale and is re-extracted', async t => {
  const f = await fixture(t);
  const [first] = await learn(f, add('sk_denominator', procedure));
  await f.bank.reject(first.proposalId, { by: 'local_user', at: new Date().toISOString(), note: 'Too broad' });
  assert.deepEqual(await f.bank.skills(), []);
  await learn(f, async () => { throw Error('rejected jobs are final'); });
  assert.equal((await jobFile(f, first.id)).status, 'rejected');

  const fb = await feedback(f.state, { runId: f.run.runId, comment: 'Explicit zero is valid caller input.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'correction' });
  const [added] = await learn(f, add('sk_denominator', procedure), { feedbackOnly: true });
  await f.bank.approve(added.proposalId, { by: 'local_user', at: new Date().toISOString() });
  const second = await feedback(f.state, { runId: f.run.runId, comment: 'Omitted and zero counts must stay distinct.', range: { path: 'app.py', startLine: 1, endLine: 2 }, verdict: 'correction' });
  const revise = learner(input => ({ operations: [{ op: 'revise', id: 'sk_denominator', expectedRevision: 1, sourceIds: [input.source.id], reason: 'Add omitted-value trigger',
    content: { ...procedure, conditions: [...procedure.conditions, 'When callers may omit the count entirely.'] }, comparison: compare(input, 'sk_denominator', 'overlaps') }] }));
  const [proposed] = await learn(f, revise, { feedbackOnly: true });
  assert.equal(proposed.status, 'proposed'); assert.notEqual(second.job.id, fb.job.id);
  await f.bank.manage('sk_denominator');
  await assert.rejects(f.bank.approve(proposed.proposalId, { by: 'local_user', at: new Date().toISOString() }), /changed since proposal.*stale/);
  assert.equal((await f.bank.proposal(proposed.proposalId)).status, 'stale');
  let reextracted = 0;
  await learn(f, async input => { reextracted++; assert.equal(input.bankSnapshotId, (await f.bank.current()).id); assert.equal(input.existingSkills.catalog.find(c => c.id === 'sk_denominator').state, 'retired'); return { result: { operations: [{ op: 'noop', reason: 'Skill was retired meanwhile' }] }, usage: null, requests: 1 }; }, { feedbackOnly: true });
  assert.equal(reextracted, 1);
  assert.equal((await jobFile(f, proposed.id)).status, 'noop');
});

test('Layer 1: the learner must compare against every shown Skill, consistently with its operation', async t => {
  const f = await fixture(t);
  const [job] = await learn(f, add('sk_denominator', procedure), { approval: 'auto' });
  assert.equal(job.status, 'applied');
  const fb = await feedback(f.state, { runId: f.run.runId, comment: 'Explicit zero matters here.', range: { path: 'app.py', startLine: 1, endLine: 2 } });
  const input = await buildInput(f.state, fb.job.sourceId), identity = learningIdentity(input);
  const [shown] = identity.visible.existingSkills.catalog, source = [identity.visible.source.ref];
  const target = identity.visible.newTargets[0];
  const page = identity.visible.sourcePages[0].ref;
  const body = { ...unrelated, dependencies: undefined, dependencyRefs: [page] }; delete body.dependencies;
  const op = (extra) => ({ operations: [{ op: 'add', targetRef: target, sourceRefs: source, reason: 'New method', content: body, ...extra }] });
  assert.throws(() => identity.resolve(op({})), /comparison required/);
  assert.throws(() => identity.resolve(op({ comparison: [] })), /incomplete/);
  assert.throws(() => identity.resolve(op({ comparison: [{ ref: 'catalog_forged_1', relation: 'distinct', note: 'x' }] })), /not shown/);
  assert.throws(() => identity.resolve(op({ comparison: [{ ref: shown.ref, relation: 'same', note: 'Restates the denominator check' }] })), /Same experience as sk_denominator/);
  assert.throws(() => identity.resolve(op({ comparison: [{ ref: shown.ref, relation: 'distinct', note: '  ' }] })), /note/);
  const attach = { operations: [{ op: 'attach_source', targetRef: shown.ref, sourceRefs: source, reason: 'Same method', comparison: [{ ref: shown.ref, relation: 'distinct', note: 'Unrelated' }] }] };
  assert.throws(() => identity.resolve(attach), /must be compared as same or overlaps/);
  const ok = identity.resolve(op({ comparison: [{ ref: shown.ref, relation: 'distinct', note: 'Cache invalidation, not denominator validation' }] }));
  assert.deepEqual(ok.operations[0].comparison, [{ id: 'sk_denominator', revision: 1, relation: 'distinct', note: 'Cache invalidation, not denominator validation' }]);
  // Defense in depth: the bank re-checks comparisons on host-resolved operations too.
  await assert.rejects(f.bank.propose('direct', input, { operations: [{ op: 'add', id: 'sk_cache', expectedRevision: 0, sourceIds: [input.source.id], reason: 'x', content: unrelated }] }), /comparison required/);
});

test('Layer 2: writes are normalized and restated or near-duplicate experience is refused against the whole bank', async t => {
  const messy = { ...procedure, title: '  Check   denominator contract at call boundaries ', conditions: ['When the denominator is an optional input.', 'when the denominator is an OPTIONAL input.'.replace('OPTIONAL', 'optional')],
    paths: ['./app.py/'], languages: ['python'], keywords: ['count', 'Count'] };
  const clean = normalizeContent(messy);
  assert.equal(clean.title, procedure.title); assert.deepEqual(clean.paths, ['app.py']); assert.deepEqual(clean.languages, ['Python']); assert.deepEqual(clean.keywords, ['count']);
  assert.equal(clean.conditions.length, 1); assert.equal(digest(normalizeContent(messy)), digest(normalizeContent(procedure)));
  assert.equal(similarity(procedure, unrelated) < SIMILARITY_POLICY.warn, true);

  const f = await fixture(t);
  await learn(f, add('sk_denominator', procedure), { approval: 'auto' });
  const fb = await feedback(f.state, { runId: f.run.runId, comment: 'Another view of the same check.', range: { path: 'app.py', startLine: 1, endLine: 2 } });
  const input = await buildInput(f.state, fb.job.sourceId);
  const proposeAdd = (id, content) => f.bank.propose(id, input, { operations: [{ op: 'add', id: 'sk_' + id, expectedRevision: 0, sourceIds: [input.source.id], reason: 'claimed new', content, comparison: compare(input, null) }] });
  await assert.rejects(proposeAdd('exact', messy), /Duplicate content: attach source to sk_denominator/);
  const restated = { ...procedure, title: 'Check the denominator contract at call boundaries', steps: [...procedure.steps].reverse() };
  await assert.rejects(proposeAdd('restated', restated), /Near-duplicate of sk_denominator/);
  // Shares the trigger and first step but checks units instead of the guard: overlapping, not the same experience.
  const related = { ...procedure, steps: [procedure.steps[0], 'Compare the unit of the numerator and denominator before division.'] };
  const score = similarity(related, procedure);
  assert(score >= SIMILARITY_POLICY.warn && score < SIMILARITY_POLICY.block, `fixture similarity ${score}`);
  const staged = await proposeAdd('related', related);
  assert.equal(staged.outcome, 'proposed');
  assert.match((await f.bank.proposal(staged.proposalId)).warnings.join(), /resembles sk_denominator/);
  // Pending knowledge occupies its content: a second learner cannot stage the same thing again.
  const other = await feedback(f.state, { runId: f.run.runId, comment: 'Units again.', range: { path: 'app.py', startLine: 1, endLine: 2 } });
  const next = await buildInput(f.state, other.job.sourceId);
  await assert.rejects(f.bank.propose('again', next, { operations: [{ op: 'add', id: 'sk_units', expectedRevision: 0, sourceIds: [next.source.id], reason: 'again', content: related, comparison: compare(next, null) }] }), /Duplicate content/);
});

test('automatic approval is limited to internal evaluation', async t => {
  const f = await fixture(t);
  const { evaluation: _evaluation, ...product } = f.options;
  await assert.rejects(new ReviewEngine(runtime(finish)).run({ ...product, skillApproval: 'auto' }), /limited to internal evaluation/);
});
