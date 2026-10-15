import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFindingId, decodeFindingId } from '../dist/index.js';

test('finding identifiers survive browser path normalization and round-trip exactly', () => {
  for (const id of ['.', '..', '../路径/100%?#', 'a/b', '问题🙂', '\ud800', 'a'.repeat(4000), '\0'.repeat(4000)]) {
    const segment = encodeFindingId(id);
    assert.match(segment, /^f_[A-Za-z0-9_-]+$/);
    assert.ok(segment.length <= 32005);
    const url = new URL(`/runs/run/findings/${segment}/evidence/0`, 'http://127.0.0.1:1234');
    assert.equal(url.pathname.split('/')[4], segment);
    assert.equal(decodeFindingId(segment), id);
  }
});

test('finding segments reject invalid, oversized and non-canonical values', () => {
  for (const segment of ['..', 'plain-id', 'f_', 'f_!!!!', encodeFindingId('id') + '=', 'f_'.padEnd(32006, 'a'), 'f_eyJpZCI6ImEifQ']) {
    assert.throws(() => decodeFindingId(segment));
  }
  for (const id of ['', '   ', 'a'.repeat(4001)]) assert.throws(() => encodeFindingId(id));
});
