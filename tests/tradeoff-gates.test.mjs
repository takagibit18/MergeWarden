import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decideAcceptedTradeoff, locateAnchor } from '../src/skills/tradeoff.ts';
import { skillRules } from '../src/skills/context.ts';

const sha = text => createHash('sha256').update(text).digest('hex');
const SNAP = 'f'.repeat(64);
const accepted = 'def ratio(total, count):\n    return total / count';
const anchor = { path: 'pkg/app.py', lineCount: 2, sha256: sha(accepted) };
const entry = (skill = {}, extra = {}) => ({ skill: { id: 'sk_t', revision: 3, type: 'accepted_tradeoff', state: 'active', paths: ['pkg'], ...skill }, reason: 'r', freshness: 'current', anchor: { path: 'pkg/app.py', startLine: 4, endLine: 5 }, ...extra });
const ev = (extra = {}) => ({ snapshotId: SNAP, revision: 'head', path: 'pkg/app.py', startLine: 5, endLine: 5, contentSha256: 'a'.repeat(64), ...extra });
const finding = (extra = {}) => ({ severity: 'medium', evidence: [ev()], ...extra });
const citation = { skillId: 'sk_t', note: 'No new caller; count is still validated upstream.' };
const decide = (f = finding(), e = entry(), read = new Set(['sk_t'])) => decideAcceptedTradeoff(f, citation, e, read, SNAP);

test('a finding that passes every gate folds with the Skill revision and note', () => {
  assert.deepEqual(decide(), { kind: 'folded', skillId: 'sk_t', revision: 3, note: citation.note });
  assert.equal(decide(finding({ severity: 'low', evidence: [ev(), ev({ startLine: 4, endLine: 5 }), ev({ revision: 'base', startLine: 1, endLine: 40 })] })).kind, 'folded');
});

test('each fold gate rejects with its own reason, in ADR order', () => {
  const cases = [
    [decideAcceptedTradeoff(finding(), citation, undefined, new Set(['sk_t']), SNAP), /not in this run's frozen catalog/],
    [decide(finding(), entry({ type: 'repo_contract' })), /not an accepted trade-off/],
    [decide(finding(), entry({ state: 'trial' })), /not active/],
    [decide(finding(), entry(), new Set()), /was not read in this run/],
    [decide(finding(), entry({}, { freshness: 'recheck', anchor: undefined })), /anchor was not found/],
    [decide(finding({ evidence: [ev(), ev({ path: 'other/app.py' })] })), /outside Skill sk_t paths/],
    [decide(finding({ evidence: [ev({ path: 'pkgx/app.py' })] }), entry({ paths: ['pkg'] })), /outside Skill sk_t paths/],
    [decide(finding({ evidence: [ev(), ev({ path: 'pkg/util.py' })] })), /cites a file other than the accepted lines/],
    [decide(finding({ evidence: [ev(), ev({ revision: 'base', path: 'pkg/util.py' })] })), /cites a file other than the accepted lines/],
    [decide(finding({ evidence: [ev({ startLine: 6, endLine: 9 })] })), /Head evidence must lie inside the accepted lines/],
    [decide(finding({ evidence: [ev({ startLine: 1, endLine: 200 })] })), /Head evidence must lie inside the accepted lines/],
    [decide(finding({ evidence: [ev(), ev({ startLine: 3, endLine: 4 })] })), /Head evidence must lie inside the accepted lines/],
    [decide(finding({ evidence: [ev({ revision: 'base' })] })), /Head evidence must lie inside the accepted lines/],
    [decide(finding({ evidence: [ev({ snapshotId: 'e'.repeat(64) })] })), /Head evidence must lie inside the accepted lines/],
  ];
  for (const [decision, reason] of cases) { assert.equal(decision.kind, 'rejected'); assert.match(decision.reason, reason); }
});

test('critical and high findings are never folded, whatever the Skill says', () => {
  for (const severity of ['critical', 'high']) assert.deepEqual(decide(finding({ severity })), { kind: 'rejected', reason: `Severity ${severity} is never folded` });
});

test('the anchor is found after lines shift and is missing once the accepted lines change', () => {
  assert.deepEqual(locateAnchor(accepted + '\n', anchor), { path: 'pkg/app.py', startLine: 1, endLine: 2 });
  assert.deepEqual(locateAnchor('import os\n\n\n' + accepted + '\n\nprint(1)\n', anchor), { path: 'pkg/app.py', startLine: 4, endLine: 5 });
  assert.equal(locateAnchor('def ratio(total, count):\n    return total / max(count, 1)\n', anchor), undefined);
  assert.equal(locateAnchor('', anchor), undefined);
});

test('the anchor is found only as one copy outside the lines this snapshot changed', () => {
  assert.equal(locateAnchor(accepted + '\n\n' + accepted + '\n', anchor), undefined);
  assert.equal(locateAnchor('x = 1\n' + accepted + '\n', anchor, { startLine: 1, endLine: 2 }), undefined);
  assert.equal(locateAnchor('x = 1\n' + accepted + '\n', anchor, { startLine: 3, endLine: 9 }), undefined);
  assert.deepEqual(locateAnchor('x = 1\n' + accepted + '\ny = 2\n', anchor, { startLine: 4, endLine: 4 }), { path: 'pkg/app.py', startLine: 2, endLine: 3 });
});

test('Skill rules keep the pre-ADR text unless the frozen package selects an accepted trade-off', () => {
  const pkg = (selectionPolicyVersion, ...types) => ({ selectionPolicyVersion, selected: types.map(type => ({ skill: { type } })) });
  const PRE_ADR_SHA256 = '72742df4ce971d159e14113468f302617b218bf014e802bd429a98c1012253da';
  assert.equal(sha(skillRules(pkg('review-skills-2', 'review_procedure'))), PRE_ADR_SHA256);
  assert.equal(sha(skillRules(pkg('review-skills-3', 'review_procedure'))), PRE_ADR_SHA256);
  assert.doesNotMatch(skillRules(pkg('review-skills-3', 'review_procedure')), /acceptedTradeoff|Known and accepted/);
  const withTradeoff = skillRules(pkg('review-skills-3', 'review_procedure', 'accepted_tradeoff'));
  assert.match(withTradeoff, /add acceptedTradeoff \{skillId, note\}/); assert.doesNotMatch(withTradeoff, /Never suppress/);
  assert.equal(skillRules(pkg('review-skills-3')), undefined);
});
