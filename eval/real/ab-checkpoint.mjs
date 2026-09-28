import assert from 'node:assert/strict';
import {digest} from './open-label.mjs';
/** An early reviewed interruption never bypasses the first ten-pair checkpoint. */
export function resumeLimit(experiment,runs,review) {
  assert.equal(review.decision,'CONTINUE');assert.equal(review.experimentSha256,experiment.experimentSha256);
  assert.equal(review.reviewedRuns,runs.length);assert.equal(review.observedRunsSha256,digest(runs));
  const firstCheckpoint=experiment.checkpointPairs*2;
  return runs.length<firstCheckpoint?firstCheckpoint:experiment.plan.length;
}
