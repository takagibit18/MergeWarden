import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFixture } from './repository-fixture.mjs';
import { ReviewEngine } from '../src/engine/review.ts';
import { readRun } from '../src/engine/reports.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { SkillBank } from '../src/skills/bank.ts';
import { learnPending } from '../src/skills/learning.ts';
import { learningIdentity } from '../src/skills/identity.ts';
import { ingestComment, parseCommand, publishState, recordRun, trustedAuthor, writeStateIgnore } from '../src/channels/github.ts';

const exec = promisify(execFile);
const TRADEOFF = `---
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
const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args], { windowsHide: true })).stdout.trim();
const runtime = async options => ({ journal: new MemoryJournal(), async prompt() { const t = Object.fromEntries(options.tools.map(x => [x.name, x.execute])); await t.read_diff({ path: 'app.py' }); await t.submit_review({ summary: 'Synthetic test only', reviewedPaths: ['app.py'], findings: [] }); }, async abort() {}, dispose() {}, usage: () => ({ input: 1, output: 1, total: 2 }) });
const KEY = 'github:octo/app', REPO = 'octo/app';
const comment = (id, body, extra = {}) => ({ id, body, url: `https://api.github.com/repos/${REPO}/issues/comments/${id}`, html_url: `https://github.com/${REPO}/pull/7#issuecomment-${id}`, author_association: 'COLLABORATOR', user: { login: 'alice', type: 'User' }, ...extra });
const addTradeoff = async input => {
  const identity = learningIdentity(input);
  return { result: identity.resolve({ operations: [{ op: 'add', targetRef: identity.visible.newTargets[0], sourceRefs: [identity.visible.source.ref], reason: 'Collaborator accepted this trade-off', comparison: [], skill: { markdown: TRADEOFF } }] }), requests: 1, usage: null };
};

async function stateRepos(t) {
  const f = await repositoryFixture(t), head = await f.change();
  const remote = join(f.directory, 'state.git');
  await exec('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = join(f.directory, 'seed'); await git(f.directory, 'clone', '-q', remote, seed);
  await writeFile(join(seed, 'README.md'), 'state\n'); await git(seed, 'add', '.'); await git(seed, 'commit', '-q', '-m', 'init'); await git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const clone = async name => { const dir = join(f.directory, name); await git(f.directory, 'clone', '-q', remote, dir); return { dir, state: join(dir, 'octo', 'app') }; };
  const review = state => new ReviewEngine(runtime).run({ repositoryPath: f.repository, stateDir: state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' }, evaluation: { tools: 'text-only' }, skills: 'auto', learn: 'off', skillRepositoryKey: KEY });
  return { ...f, head, remote, clone, review };
}

test('the /mw command parser keeps verdict, finding and free text apart', () => {
  assert.equal(parseCommand('LGTM'), null);
  assert.equal(parseCommand('please /mw later'), null);
  assert.deepEqual(parseCommand('\n/mw tradeoff finding:C2 callers validate\nsecond line'), { verdict: 'accepted_tradeoff', findingId: 'C2', comment: 'callers validate\nsecond line' });
  assert.deepEqual(parseCommand('/mw zero is a valid sentinel here'), { comment: 'zero is a valid sentinel here' });
  assert.deepEqual(parseCommand('/mw wrong'), { verdict: 'correction', comment: '' });
});

test('only human owners, members and collaborators are trusted', () => {
  assert.equal(trustedAuthor({ user: { type: 'User' }, author_association: 'COLLABORATOR' }), true);
  assert.equal(trustedAuthor({ user: { type: 'User' }, author_association: 'CONTRIBUTOR' }), false);
  assert.equal(trustedAuthor({ user: { type: 'Bot' }, author_association: 'MEMBER' }), false);
});

test('comment ingest converges on the current comment: replay, edit, unmark and delete', async t => {
  const f = await stateRepos(t), { state } = await f.clone('a');
  const run = await f.review(state); await recordRun(state, REPO, 7, run.runId);
  const ingest = current => ingestComment(state, { repository: REPO, eventName: 'issue_comment', pullNumber: 7, commentId: 11, current });
  assert.equal((await ingestComment(state, { repository: REPO, eventName: 'issue_comment', pullNumber: 7, commentId: 12, current: comment(12, '/mw zero', { author_association: 'CONTRIBUTOR' }) })).status, 'ignored');
  assert.equal((await ingestComment(state, { repository: REPO, eventName: 'issue_comment', pullNumber: 7, commentId: 13, current: comment(13, '/mw zero', { user: { login: 'codex[bot]', type: 'Bot' } }) })).status, 'ignored');
  assert.equal((await ingestComment(state, { repository: REPO, eventName: 'issue_comment', pullNumber: 8, commentId: 14, current: comment(14, '/mw zero') })).status, 'rejected');

  const saved = await ingest(comment(11, '/mw Explicit zero differs from omitted input.'));
  assert.equal(saved.status, 'saved');
  assert.deepEqual([saved.source.eventId, saved.source.version, saved.source.identity, saved.source.trust, saved.source.repositoryKey], ['fb-gh-ic-11', 1, 'github_collaborator', 'trusted', KEY]);
  assert.deepEqual([saved.source.channel.author, saved.source.channel.association, saved.source.channel.pullNumber], ['alice', 'COLLABORATOR', 7]);
  assert.equal((await ingest(comment(11, '/mw Explicit zero differs from omitted input.'))).status, 'unchanged');
  const edited = await ingest(comment(11, '/mw Explicit zero must be rejected by callers.'));
  assert.deepEqual([edited.status, edited.source.version], ['saved', 2]);
  const unmarked = await ingest(comment(11, 'never mind'));
  assert.deepEqual([unmarked.status, unmarked.source.version, unmarked.source.withdrawn], ['withdrawn', 3, true]);
  assert.equal((await ingest(null)).status, 'unchanged');
});

test('a collaborator trade-off comment survives a fresh runner, is learned without approval, and reaches the next review', async t => {
  const f = await stateRepos(t);
  const a = await f.clone('runner-review');
  const run = await f.review(a.state); await recordRun(a.state, REPO, 7, run.runId);
  await writeStateIgnore(a.state);
  assert.deepEqual(await publishState(a.dir, 'review'), { pushed: true, commit: await git(a.dir, 'rev-parse', 'HEAD'), attempts: 1 });
  const tree = (await git(f.remote, 'ls-tree', '-r', '--name-only', 'main')).split('\n');
  assert.ok(tree.includes(`octo/app/runs/${run.runId}/report.json`) && tree.includes('octo/app/channels/github/pulls/7.json'));
  assert.ok(tree.some(p => p.startsWith('octo/app/snapshots/')), 'snapshot manifest persisted');
  assert.ok(!tree.some(p => /\/(blobs|graphs|locks|auth)\//.test(p) || p.endsWith('.lock') || p.endsWith('session.jsonl')), tree.join('\n'));

  const b = await f.clone('runner-feedback'), other = await f.clone('runner-other-project');
  await assert.rejects(access(join(b.state, 'blobs')), 'fresh runner starts without frozen source');
  const inline = comment(21, '/mw tradeoff Callers validate count; the unguarded division is deliberate.', { side: 'RIGHT', start_side: 'RIGHT', path: 'app.py', original_start_line: 1, original_line: 2, original_commit_id: f.head });
  const saved = await ingestComment(b.state, { repository: REPO, eventName: 'pull_request_review_comment', pullNumber: 7, commentId: 21, current: inline, repositoryPath: f.repository });
  assert.equal(saved.status, 'saved', saved.reason);
  assert.deepEqual(saved.source.range, { path: 'app.py', startLine: 1, endLine: 2 });
  assert.equal(saved.source.anchor.lineCount, 2);
  const [job] = await learnPending(b.state, addTradeoff, { model: { provider: 'fixture', modelId: 'offline' }, approval: 'auto', feedbackOnly: true, repositoryKey: KEY });
  assert.equal(job.status, 'applied', job.error);
  const bank = new SkillBank(b.state), [skill] = await bank.skills();
  assert.deepEqual([skill.type, skill.state, skill.repositoryKey], ['accepted_tradeoff', 'active', KEY]);
  assert.equal((await bank.proposal(job.proposalId)).decision.by, 'host_auto');

  await mkdir(join(other.dir, 'octo', 'other'), { recursive: true }); await writeFile(join(other.dir, 'octo', 'other', 'note.json'), '{}\n');
  await publishState(other.dir, 'other project');
  await writeStateIgnore(b.state);
  const pushed = await publishState(b.dir, 'feedback');
  assert.deepEqual([pushed.pushed, pushed.attempts], [true, 2], 'rejected push rebases onto the other project and retries');

  const c = await f.clone('runner-next-review');
  const next = await f.review(c.state);
  const binding = (await readRun(c.state, next.runId)).skills;
  assert.equal(binding.repositoryKey, KEY);
  assert.deepEqual(binding.available.map(s => s.id), [skill.id], 'the next review on a fresh runner sees the learned Skill');
});

test('the github CLI reads webhook payloads: PR comments are ingested, deletions withdraw, issue comments are ignored', async t => {
  const f = await stateRepos(t), { state } = await f.clone('cli');
  const run = await f.review(state);
  const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
  const call = async (...args) => JSON.parse((await exec(process.execPath, ['--experimental-strip-types', cli, 'github', ...args, '--repo', f.repository, '--state', state, '--repository', REPO], { windowsHide: true })).stdout);
  const event = async (name, payload) => { const path = join(f.directory, `${name}.json`); await writeFile(path, JSON.stringify(payload)); return path; };
  assert.equal((await call('record-run', '--pull', '7', '--run', run.runId)).runs[0].headCommit, f.head);
  const body = '/mw contract Callers must pass a positive count.';
  const created = await call('feedback', '--event-name', 'issue_comment', '--fetch', 'false', '--event-file', await event('created', { action: 'created', issue: { number: 7, pull_request: {} }, comment: comment(31, body) }));
  assert.deepEqual([created.ingest.status, created.ingest.source.verdict, created.learning.status], ['saved', 'contract', 'skipped']);
  const plainIssue = await call('feedback', '--event-name', 'issue_comment', '--fetch', 'false', '--event-file', await event('issue', { action: 'created', issue: { number: 9 }, comment: comment(32, body) }));
  assert.equal(plainIssue.ingest.status, 'ignored');
  const deleted = await call('feedback', '--event-name', 'issue_comment', '--fetch', 'false', '--event-file', await event('deleted', { action: 'deleted', issue: { number: 7, pull_request: {} }, comment: comment(31, body) }));
  assert.deepEqual([deleted.ingest.status, deleted.ingest.source.withdrawn], ['withdrawn', true]);
});
