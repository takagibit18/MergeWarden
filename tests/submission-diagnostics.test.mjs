import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine } from '../src/engine/review.ts';
import { MemoryJournal } from '../src/adapters/memory-journal.ts';
import { fullEvidence } from '../src/application/evidence-registry.ts';
import { repositoryFixture } from './repository-fixture.mjs';

async function run(t, script) {
  const f = await repositoryFixture(t, { 'a.py': 'old\n', 'b.py': 'old\n' });
  await f.write('a.py', 'first\nsecond\nthird\n'); await f.write('b.py', 'new\n'); const head = await f.commit();
  const journal = new MemoryJournal();
  const result = await new ReviewEngine(async options => ({ journal,
    async prompt() { await script(Object.fromEntries(options.tools.map(t => [t.name, t.execute])), journal); },
    async abort() {}, dispose() {}, usage: () => ({ input: 0, output: 0, total: 0 }),
  })).run({ repositoryPath: f.repository, stateDir: f.state, input: { kind: 'commits', base: f.base, head }, model: { provider: 'fixture', modelId: 'offline' } });
  assert.equal(result.report.status, 'completed');
  return result;
}

test('one coverage error identifies every unread path and first missing offset without accepting a batch', async t => {
  await run(t, async (tools, journal) => {
    await tools.read_diff({ path: 'a.py', cursor: 2, limit: 1 });
    const before = await journal.readActiveBranch();
    await assert.rejects(tools.submit_review({ summary: 'Premature fixture submission', reviewedPaths: ['a.py', 'b.py'], findings: [] }), error => {
      const e = JSON.parse(error.message);
      assert.equal(e.outcome, 'PRE_ACCEPTANCE_ERROR'); assert.equal(e.diagnostics.code, 'INCOMPLETE_DIFF_COVERAGE');
      assert.deepEqual(e.diagnostics.missing.map(x => [x.path, x.cursor]), [['a.py', 0], ['b.py', 0]]);
      assert.equal(e.diagnostics.missing[0].readLines, 1); return true;
    });
    assert.deepEqual(await journal.readActiveBranch(), before);
    for (const path of ['a.py', 'b.py']) await tools.read_diff({ path });
    await tools.submit_review({ summary: 'Fixture reviewed after repair', reviewedPaths: ['a.py', 'b.py'], findings: [] });
  });
});

test('hash repair pinpoints the bad reference while preserving the valid ID and requiring explicit evidence selection', async t => {
  const result = await run(t, async (tools, journal) => {
    for (const path of ['a.py', 'b.py']) await tools.read_diff({ path });
    const a = await tools.read_source({ revision: 'head', path: 'a.py', startLine: 1, endLine: 3 });
    const b = await tools.read_source({ revision: 'head', path: 'b.py', startLine: 1, endLine: 1 });
    const candidate = { id: 'fixture', title: 'Fixture only', claim: 'Fixture claim', trigger: 'Fixture input', impact: 'Fixture consequence', severity: 'low', evidence: [{ evidenceRefId: b._mergewarden.evidenceRefId }, { ...fullEvidence(a), startLine: 2, endLine: 2 }] };
    const before = await journal.readActiveBranch();
    await assert.rejects(tools.submit_review({ summary: 'Fixture', reviewedPaths: ['a.py', 'b.py'], findings: [candidate] }), error => {
      const e = JSON.parse(error.message); const [issue] = e.diagnostics.issues;
      assert.equal(e.diagnostics.code, 'EVIDENCE_INTEGRITY'); assert.equal(e.diagnostics.issues.length, 1);
      assert.equal(issue.candidateId, 'fixture'); assert.equal(issue.evidenceIndex, 1);
      assert.equal(issue.reference.path, 'a.py'); assert.equal(issue.reference.startLine, 2);
      assert.equal(issue.code, 'SOURCE_HASH_MISMATCH'); return true;
    });
    assert.deepEqual(await journal.readActiveBranch(), before);
    candidate.evidence = [{ evidenceRefId: b._mergewarden.evidenceRefId }, { evidenceRefId: a._mergewarden.evidenceRefId }];
    await tools.submit_review({ summary: 'Fixture explicitly repaired', reviewedPaths: ['a.py', 'b.py'], findings: [candidate] });
  });
  assert.deepEqual(result.report.findings[0].evidence.map(e => [e.path, e.startLine, e.endLine]), [['b.py', 1, 1], ['a.py', 1, 3]]);
});
