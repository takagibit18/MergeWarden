import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { SkillBank } from '../src/skills/bank.ts';
import { registerRun, learnPending, buildInput } from '../src/skills/learning.ts';
import { learningIdentity } from '../src/skills/identity.ts';
import { catalog } from '../src/skills/context.ts';
import { parseSkillMarkdown, parseReferences, renderSkillMarkdown } from '../src/skills/skill-md.ts';

const SKILL = `---
name: validated-params-keep-documented-inputs
description: "Use when a change adds or tightens parameter validation on a public function; checks that constraints still accept every documented and previously valid input."
type: review_procedure
scope: review_method
paths: [pkg]
languages: [Python]
keywords: [validate_params, "Interval(", StrOptions]
symbols:
  - validate_params
dependencyRefs: []
---
# Check new parameter constraints against documented inputs

## When to use
- A public function gains or changes declarative parameter validation.

## Procedure
1. List each constrained parameter and its documented accepted forms.
2. Confirm every documented or previously accepted form still passes the new constraint
   before the unchanged implementation runs.

## Not a defect when
- The rejected form was never documented nor reachable before.

## Stop when
- Every constrained parameter was compared with its documented forms.
`;

test('SKILL.md parses into structured content and renders back to an equivalent document', () => {
  const { content, dependencyRefs } = parseSkillMarkdown(SKILL);
  assert.equal(content.name, 'validated-params-keep-documented-inputs');
  assert.equal(content.scopeType, 'review_method');
  assert.deepEqual(content.keywords, ['validate_params', 'Interval(', 'StrOptions']);
  assert.deepEqual(content.symbols, ['validate_params']);
  assert.equal(content.steps.length, 2);
  assert.match(content.steps[1], /previously accepted form still passes the new constraint before/);
  assert.deepEqual(dependencyRefs, []);
  const again = parseSkillMarkdown(renderSkillMarkdown({ ...content, dependencies: [] }));
  assert.deepEqual(again.content, content);
});

test('SKILL.md rejects unknown sections, missing frontmatter and scripts in references', () => {
  assert.throws(() => parseSkillMarkdown(SKILL.replace('## Stop when', '## Notes')), /Unknown SKILL.md section/);
  assert.throws(() => parseSkillMarkdown(SKILL.replace(/^---[\s\S]*?---\n/, '')), /frontmatter/);
  assert.throws(() => parseSkillMarkdown(SKILL.replace('name: validated-params-keep-documented-inputs\n', '')), /requires name and description/);
  assert.throws(() => parseSkillMarkdown(SKILL.replace('type: review_procedure', 'run: rm -rf /')), /Unknown Skill frontmatter key/);
  assert.throws(() => parseReferences({ 'check.py': 'print(1)' }), /cannot carry scripts/);
  assert.throws(() => parseReferences({ 'a.md': 'x', 'b.md': 'y', 'c.md': 'z' }), /At most 2/);
  assert.deepEqual(parseReferences({ 'example.md': '# Incident' }), { 'example.md': '# Incident' });
});

const runtime = script => async options => ({ journal: new MemoryJournal(), async prompt(text) { await script(Object.fromEntries(options.tools.map(t => [t.name, t.execute])), options, text); }, async abort() {}, dispose() {}, usage: () => ({ input: 1, output: 1, total: 2 }) });
const finish = async t => { await t.read_diff({ path: 'app.py' }); await t.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [] }); };
async function fixture(t) {
  const f = await repositoryFixture(t), head = await f.change();
  const options = { repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' }, evaluation: { tools: 'text-only' }, skills: 'auto', learn: 'auto', skillApproval: 'auto' };
  const run = await new ReviewEngine(runtime(finish)).run(options);
  return { ...f, head, options, run, bank: new SkillBank(f.state) };
}
const markdownOp = (markdown, references) => input => {
  return resolveMarkdown(markdown, references, input);
};
const resolveMarkdown = (markdown, references, input) => {
  const identity = learningIdentity(input);
  return identity.resolve({ operations: [{ op: 'add', targetRef: identity.visible.newTargets[0], sourceRefs: [identity.visible.source.ref], reason: 'Reusable validation method', skill: { markdown, ...(references ? { references } : {}) }, comparison: [] }] });
};

test('learner SKILL.md output is stored, and the review sees name and description first, then body, then references', async t => {
  const f = await fixture(t), skill = SKILL.replace('dependencyRefs: []\n', '');
  const jobs = await learnPending(f.state, async input => ({ result: markdownOp(skill, { 'example.md': '# Incident\nA validator rejected documented arrays.' })(input), requests: 1, usage: null }), { model: f.options.model, approval: 'auto' });
  assert.equal(jobs[0].status, 'applied');
  const [stored] = await f.bank.skills();
  assert.equal(stored.name, 'validated-params-keep-documented-inputs');
  assert.deepEqual(Object.keys(stored.references), ['example.md']);
  let seen;
  await new ReviewEngine(runtime(async (tools, _options, text) => {
    const entry = JSON.parse(text.split('Fallible experience catalog (not source evidence): ')[1]).find(e => e.id === stored.id);
    assert.deepEqual(Object.keys(entry).sort(), ['contentSha256', 'description', 'freshness', 'id', 'name', 'reason', 'revision', 'state', 'type']);
    await assert.rejects(tools.read_review_skill({ id: stored.id, reference: 'example.md' }), /before its references/);
    const body = await tools.read_review_skill({ id: stored.id });
    assert.equal(body.format, 'skill-md-1'); assert.deepEqual(body.references, ['example.md']);
    assert.match(body.markdown, /^---\nname: validated-params-keep-documented-inputs/);
    seen = await tools.read_review_skill({ id: stored.id, reference: 'example.md' });
    await assert.rejects(tools.read_review_skill({ id: stored.id, reference: 'other.md' }), /Unknown Skill reference/);
    await finish(tools);
  })).run({ ...f.options, learn: 'off' });
  assert.match(seen.markdown, /validator rejected documented arrays/);
});

test('review methods in SKILL.md cannot be scoped to a single file', async t => {
  const f = await fixture(t);
  const jobs = await learnPending(f.state, async input => ({ result: markdownOp(SKILL.replace('paths: [pkg]', 'paths: [app.py]').replace('dependencyRefs: []\n', ''))(input), requests: 1, usage: null }), { model: f.options.model, approval: 'auto' });
  assert.equal(jobs[0].status, 'failed');
  assert.match(jobs[0].error, /Review methods scope by module directory/);
});

test('legacy catalog entries keep their frozen shape', () => {
  const legacy = { id: 'sk_x', revision: 1, contentSha256: 'a'.repeat(64), title: 'Old title', state: 'trial', type: 'review_procedure', conditions: ['c1', 'c2', 'c3'] };
  const [entry] = catalog({ selected: [{ skill: legacy, reason: 'r', freshness: 'current' }] });
  assert.deepEqual(Object.keys(entry), ['id', 'revision', 'contentSha256', 'title', 'state', 'type', 'conditions', 'catalogTruncated', 'reason', 'freshness']);
});

test('run experience becomes active only after support from a second, different reviewed change', async t => {
  // `ratio` occurs in the fixture diff, so the learning context shows this Skill's body for the second change.
  const f = await fixture(t), skill = SKILL.replace('dependencyRefs: []\n', '').replace('keywords: [', 'keywords: [ratio, ');
  await learnPending(f.state, async input => ({ result: markdownOp(skill)(input), requests: 1, usage: null }), { model: f.options.model, approval: 'auto' });
  const [first] = await f.bank.skills(); assert.equal(first.state, 'trial');
  // A second, different change in the same repository supports the same method.
  await f.write('app.py', 'def ratio(total, count):\n    return total // count\n'); const head2 = await f.commit();
  const second = await new ReviewEngine(runtime(finish)).run({ ...f.options, input: { kind: 'commits', base: f.head, head: head2 }, learn: 'off' });
  const job = await registerRun(f.state, second.runId), input = await buildInput(f.state, job.sourceId);
  const attach = { op: 'attach_source', id: first.id, expectedRevision: first.revision, sourceIds: [input.source.id], reason: 'Same method on a new change', comparison: input.existingSkills.catalog.map(c => ({ id: c.id, revision: c.revision, relation: c.id === first.id ? 'same' : 'distinct', note: 'Same validation check' })) };
  await f.bank.apply(job.id, input, { operations: [attach] });
  const [promoted] = await f.bank.skills();
  assert.equal(promoted.state, 'active'); assert.equal(promoted.sources.length, 2);
});
