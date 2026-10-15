import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildEvidenceDiff } from '../src/application/workbench/index.ts';

const HASH = 'a'.repeat(64);
const input = (before, after, overrides = {}) => ({ snapshotId: HASH, path: 'app.py', before, after,
  baseMode: before === null ? null : '100644', headMode: after === null ? null : '100644', ...overrides });
const tokens = text => text === null ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
const raw = row => row.text + (row.noFinalNewline ? '' : '\n');

/** Apply the returned hunks and verify their actual counts and source coordinates. */
function applyRows(before, rows) {
  const source = tokens(before), output = [];
  let sourceIndex = 0, index = 0;
  while (index < rows.length) {
    const header = rows[index++];
    assert.equal(header.kind, 'hunk');
    assert.equal(header.baseLine, null); assert.equal(header.headLine, null);
    const start = header.hunk.baseStart - (header.hunk.baseCount ? 1 : 0);
    assert.ok(start >= sourceIndex);
    output.push(...source.slice(sourceIndex, start)); sourceIndex = start;
    let baseCount = 0, headCount = 0;
    let headLine = header.hunk.headStart + (header.hunk.headCount ? 0 : 1);
    while (index < rows.length && rows[index].kind !== 'hunk') {
      const row = rows[index++];
      if (row.kind !== 'addition') {
        assert.equal(row.baseLine, sourceIndex + 1);
        assert.equal(raw(row), source[sourceIndex++]); baseCount++;
      } else assert.equal(row.baseLine, null);
      if (row.kind !== 'deletion') {
        assert.equal(row.headLine, headLine++);
        output.push(raw(row)); headCount++;
      } else assert.equal(row.headLine, null);
    }
    assert.equal(baseCount, header.hunk.baseCount);
    assert.equal(headCount, header.hunk.headCount);
  }
  output.push(...source.slice(sourceIndex));
  return output.join('');
}

test('display diff separates distant edits with exact three-line context and both coordinates', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const after = [...before]; after[3] = 'first change'; after[24] = 'second change';
  const diff = buildEvidenceDiff(input(before.join('\n') + '\n', after.join('\n') + '\n'));
  assert.equal(diff.status, 'ok');
  assert.deepEqual(diff.rows.filter(row => row.kind === 'hunk').map(row => row.hunk), [
    { baseStart: 1, baseCount: 7, headStart: 1, headCount: 7 },
    { baseStart: 22, baseCount: 7, headStart: 22, headCount: 7 },
  ]);
  assert.equal(diff.rows.filter(row => row.kind === 'deletion').length, 2);
  assert.equal(diff.rows.filter(row => row.kind === 'addition').length, 2);
  assert.ok(!diff.rows.some(row => row.text === 'line 15'));
  assert.equal(applyRows(before.join('\n') + '\n', diff.rows), after.join('\n') + '\n');
  assert.equal(diff.base.contentSha256, createHash('sha256').update(before.join('\n') + '\n').digest('hex'));
});

test('insertions and deletions preserve shifted head line numbers across separate hunks', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const after = [...before]; after.splice(2, 0, 'added one', 'added two'); after.splice(22, 1);
  const diff = buildEvidenceDiff(input(before.join('\n') + '\n', after.join('\n') + '\n'));
  assert.equal(diff.status, 'ok');
  assert.deepEqual(diff.rows.filter(row => row.kind === 'hunk').map(row => row.hunk), [
    { baseStart: 1, baseCount: 5, headStart: 1, headCount: 7 },
    { baseStart: 18, baseCount: 7, headStart: 20, headCount: 6 },
  ]);
  assert.deepEqual(diff.rows.find(row => row.kind === 'deletion'), { kind: 'deletion', text: 'line 21', baseLine: 21, headLine: null });
  assert.equal(applyRows(before.join('\n') + '\n', diff.rows), after.join('\n') + '\n');
});

test('added, deleted and empty files retain existence separately from line content', () => {
  const added = buildEvidenceDiff(input(null, 'one\ntwo\n'));
  assert.equal(added.changeType, 'added');
  assert.deepEqual(added.base, { exists: false, contentSha256: null, totalLines: 0, endsWithNewline: null, mode: null });
  assert.deepEqual(added.rows[0].hunk, { baseStart: 0, baseCount: 0, headStart: 1, headCount: 2 });
  assert.equal(applyRows(null, added.rows), 'one\ntwo\n');
  const deleted = buildEvidenceDiff(input('one\ntwo', null));
  assert.equal(deleted.changeType, 'deleted');
  assert.deepEqual(deleted.rows[0].hunk, { baseStart: 1, baseCount: 2, headStart: 0, headCount: 0 });
  assert.equal(deleted.rows.at(-1).noFinalNewline, true);
  assert.equal(applyRows('one\ntwo', deleted.rows), '');
  for (const [before, after, kind] of [[null, '', 'added'], ['', null, 'deleted'], ['', '', 'unchanged'], [null, null, 'unchanged']]) {
    const diff = buildEvidenceDiff(input(before, after));
    assert.equal(diff.changeType, kind); assert.deepEqual(diff.rows, []);
    assert.equal(diff.base.exists, before !== null); assert.equal(diff.head.exists, after !== null);
    assert.equal(diff.totalRows, 0); assert.equal(diff.nextOffset, null);
  }
});

test('final newline changes are real delete/add rows with EOF markers, including CRLF', () => {
  for (const [before, after] of [['same\n', 'same'], ['same', 'same\n'], ['old', 'new'], ['same\r\n', 'same\n']]) {
    const diff = buildEvidenceDiff(input(before, after));
    assert.equal(diff.changeType, 'modified');
    assert.deepEqual(diff.rows.filter(row => row.kind !== 'hunk').map(row => row.kind), ['deletion', 'addition']);
    assert.equal(diff.base.endsWithNewline, before.endsWith('\n'));
    assert.equal(diff.head.endsWithNewline, after.endsWith('\n'));
    assert.equal(applyRows(before, diff.rows), after);
    assert.equal(Boolean(diff.rows.find(row => row.kind === 'deletion').noFinalNewline), !before.endsWith('\n'));
    assert.equal(Boolean(diff.rows.find(row => row.kind === 'addition').noFinalNewline), !after.endsWith('\n'));
  }
});

test('unchanged content and mode-only changes never invent source edits', () => {
  const unchanged = buildEvidenceDiff(input('same\n', 'same\n'));
  assert.equal(unchanged.changeType, 'unchanged'); assert.deepEqual(unchanged.rows, []);
  const mode = buildEvidenceDiff(input('same\n', 'same\n', { headMode: '100755' }));
  assert.equal(mode.changeType, 'modified'); assert.deepEqual(mode.rows, []);
  assert.equal(mode.base.mode, '100644'); assert.equal(mode.head.mode, '100755');
  assert.equal(mode.base.contentSha256, mode.head.contentSha256);
});

test('flat diff pagination reconstructs a large hunk and always advances to the exact end', () => {
  const source = input(null, Array.from({ length: 40 }, (_, index) => `added ${index}`).join('\n') + '\n');
  const complete = buildEvidenceDiff(source), combined = [];
  let offset = 0;
  while (true) {
    const page = buildEvidenceDiff(source, { offset, limit: 2 });
    assert.equal(page.status, 'ok'); assert.ok(page.rows.length <= 2);
    assert.equal(page.totalRows, complete.totalRows); combined.push(...page.rows);
    if (page.nextOffset === null) { assert.equal(page.offset + page.rows.length, page.totalRows); assert.equal(page.truncated, false); break; }
    assert.ok(page.nextOffset > offset); assert.equal(page.nextOffset, offset + page.rows.length);
    assert.equal(page.truncated, true); offset = page.nextOffset;
  }
  assert.deepEqual(combined, complete.rows);
  assert.equal(applyRows(null, combined), source.after);
  assert.deepEqual(buildEvidenceDiff(source, { offset: complete.totalRows }).rows, []);
  assert.throws(() => buildEvidenceDiff(source, { offset: complete.totalRows + 1 }), error => error.code === 'INVALID_QUERY');
  for (const query of [{ offset: -1 }, { limit: 0 }, { limit: 201 }, { offset: 1.5 }]) {
    assert.throws(() => buildEvidenceDiff(source, query), error => error.code === 'INVALID_QUERY');
  }
});

test('output byte limits paginate independently of the row limit without stalling', () => {
  const source = input(null, Array.from({ length: 8 }, (_, index) => `${index} ${'x'.repeat(80)}`).join('\n') + '\n');
  const complete = buildEvidenceDiff(source), combined = [];
  let offset = 0;
  do {
    const page = buildEvidenceDiff(source, { offset }, { maxOutputBytes: 256 });
    assert.equal(page.status, 'ok');
    assert.ok(page.rows.length > 0); assert.ok(page.rows.length < 200);
    assert.ok(page.rows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0) <= 256);
    combined.push(...page.rows); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(combined, complete.rows);
});

test('work, trace and input budgets fail closed instead of returning replacement hunks', () => {
  for (const limits of [{ maxWork: 1 }, { maxTraceCells: 1 }, { maxInputLines: 1 }, { maxInputBytes: 1 }]) {
    const diff = buildEvidenceDiff(input('one\ntwo\n', 'other\ntwo\n'), {}, limits);
    assert.equal(diff.status, 'unavailable'); assert.deepEqual(diff.rows, []);
    assert.equal(diff.nextOffset, null); assert.equal(diff.truncated, false);
    assert.match(diff.warnings.join(' '), /budget/);
  }
  const large = Array.from({ length: 1000 }, (_, index) => `left ${index}`).join('\n') + '\n';
  const other = Array.from({ length: 1000 }, (_, index) => `right ${index}`).join('\n') + '\n';
  const exhausted = buildEvidenceDiff(input(large, other));
  assert.equal(exhausted.status, 'unavailable'); assert.deepEqual(exhausted.rows, []);
  assert.match(exhausted.warnings[0], /computation budget/);
});

test('oversized rows and escaped text produce an explicit fallback rather than an empty cursor loop', () => {
  const line = buildEvidenceDiff(input(null, 'x'.repeat(16_385) + '\n'));
  assert.equal(line.status, 'unavailable'); assert.deepEqual(line.rows, []); assert.match(line.warnings[0], /line/);
  const escaped = buildEvidenceDiff(input(null, '\ud800'.repeat(16_000) + '\n'), { offset: 1 });
  assert.equal(escaped.status, 'unavailable'); assert.equal(escaped.nextOffset, null); assert.match(escaped.warnings[0], /byte budget/);
});

test('short repeated-line combinations produce minimal edits that reconstruct the complete target', () => {
  const sequences = [[]];
  for (let length = 1; length <= 4; length++) {
    for (let pattern = 0; pattern < 2 ** length; pattern++) sequences.push(Array.from({ length }, (_, index) => pattern & (1 << index) ? 'a' : 'b'));
  }
  const lcs = (a, b) => {
    const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1] ? matrix[i - 1][j - 1] + 1 : Math.max(matrix[i - 1][j], matrix[i][j - 1]);
    }
    return matrix[a.length][b.length];
  };
  for (const a of sequences) for (const b of sequences) {
    const before = a.length ? a.join('\n') + '\n' : '', after = b.length ? b.join('\n') + '\n' : '';
    const diff = buildEvidenceDiff(input(before, after));
    assert.equal(diff.status, 'ok', `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    assert.equal(applyRows(before, diff.rows), after);
    const edits = diff.rows.filter(row => row.kind === 'addition' || row.kind === 'deletion').length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b));
  }
});
