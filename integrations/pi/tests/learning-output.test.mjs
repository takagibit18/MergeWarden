import test from 'node:test';
import assert from 'node:assert/strict';
import { learningOutput, LEARNING_PROMPT, LEARNING_PROMPT_VERSION } from '../src/learning.ts';

test('learner output tolerates envelope mistakes only and records each repair', () => {
  assert.deepEqual(learningOutput('{"operations":[{"op":"noop","reason":"a}"}]}'), { value: { operations: [{ op: 'noop', reason: 'a}' }] }, repairs: [] });
  assert.deepEqual(learningOutput('{"operations":[]}\n\nThat is all.').repairs, ['trailing_text']);
  assert.deepEqual(learningOutput('```json\n{"op":"noop","reason":"x"}\n```'), { value: { operations: [{ op: 'noop', reason: 'x' }] }, repairs: ['code_fence', 'bare_operation'] });
  assert.deepEqual(learningOutput('[{"op":"noop","reason":"q\\"]"}]').value, { operations: [{ op: 'noop', reason: 'q"]' }] });
  assert.throws(() => learningOutput('no json here'), /contains no JSON/);
  assert.throws(() => learningOutput('{"operations":['), /incomplete/);
});

test('learning prompt asks for SKILL.md that generalizes beyond the incident', () => {
  assert.equal(LEARNING_PROMPT_VERSION, 'skill-md-1');
  assert.match(LEARNING_PROMPT, /NEXT instance of the same mistake in a different file/);
  assert.match(LEARNING_PROMPT, /never single files/);
  assert.match(LEARNING_PROMPT, /never include scripts/);
});
