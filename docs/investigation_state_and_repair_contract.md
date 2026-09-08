# Investigation checkpoints and bounded repair

This document records the runtime contract introduced by the staged review
architecture. It is deliberately separate from the legacy finding payload so
old API, CLI, publisher, and evaluation consumers can continue to read the
same `ReviewIssue` envelope.

## Action classes

| Action | Runtime meaning | Can finish a review? |
| --- | --- | --- |
| Exploration | Read, search, list, changed-context, or symbol lookup | No; it adds observations |
| State | Record or update a draft hypothesis | No; a draft is a checkpoint |
| Completion | Valid `submit_review` or `submit_debug` payload | Creates a submission checkpoint; only the later pipeline guard can mark the review complete |

`record_draft_finding` and `update_draft_finding` are pseudo-actions. They are
parsed and acknowledged as model conversation turns, but are never dispatched
through the ordinary tool registry.

## Draft lifecycle

Every runtime-bound draft has an independent `DraftFindingState`:

```text
pending -> evidence_sufficient -> final submit -> verified/published
pending -> disproved       -> empty or other final submit
pending -> incomplete      -> bounded termination
```

`pending` is the default. A draft alone never authorizes finalization. A draft
that reaches `evidence_sufficient` may enter the final-submit path, but that
state is not a submission and is not a successful review. The next model turn
receives the hypothesis, its current reason, selected evidence ids, and a
concise missing-check instruction. The instruction is targeted to the
unresolved claim; it does not impose a fixed number of searches.

Duplicate draft recordings retain the first runtime id and increment a repeat
counter. A repeated state-only/no-progress turn is not considered successful.
The stagnation guard closes the run with an explicit incomplete reason after
the configured bound.

## Completion and budget rules

- A valid explicit final submission records `submission_received` and may end
  exploration. `investigation_ready` means the investigation gate is open; it
  does not mean a final submit was received. `review_complete` is emitted only
  after a submission has been observed, the runner reports a valid workflow,
  and the final finding/integrity path has completed.
- An empty or invalid model turn is `no_effective_action`, not a successful
  review by itself. It may complete only if a later bounded finalization
  receives and validates an actual final submission.
- Budget, wall-clock timeout, unrecoverable provider/tool errors, and exhausted
  iteration bounds mark still-pending drafts as `incomplete` with a reason.
- The response exposes the three lifecycle flags/statuses, the
  `completion_status`, `incomplete_reasons`, and checkpoint states. Legacy
  callers that leave all lifecycle flags false retain the historical compact
  serialization; evaluation runs emit positive lifecycle evidence. Failed
  provider calls remain attempts even when usage is unavailable; successful
  token totals and `failed_unknown_usage_count` are reported separately.

The post-repair validation profile makes the stage boundary explicit:
exploration/validation responses may use 12,288 output tokens, while a
submit-only request uses 4,096. The profile records a 120,000 soft cumulative
budget, a 160,000 hard cap, an 8,000 serialized final-submit request budget,
and one shared repair attempt. These are effective wire/runtime settings for
that experiment, not a claim that every historical run used them.

## Candidate repair states

The integrity guard classifies failures before repair is attempted:

| Class | Runtime action |
| --- | --- |
| Deterministic normalization | Convert locally, such as deriving `location` from `primary_anchor` |
| Contract gap | Return candidate id, field, reason, and required semantic field/action |
| Source gap | Re-enter bounded exploration for the missing observed range |
| Unresolved protocol/ID reference | Recoverable; retain the exact `reference_id` and ask for a legal delivered catalog id |
| Known but undelivered reference | Recoverable catalog gap; do not promote ledger history into delivered evidence |
| Out-of-range or explicit wrong path/snapshot/revision/hash | Untrusted identity; reject and never guess a nearby span or snapshot |
| Ambiguous/duplicate target candidate | Reject the repair merge; leave every candidate unchanged |

Repair consumes one shared `review_repair_max_attempts` budget across schema,
contract, reference, and source-gap work. Feedback names one exact runtime
`target_candidate_id` and carries the current finding id, original semantic
content, hashes, gap details, and required action. A candidate is repaired only
after the merged report passes the same integrity guard again. Already
verified candidates remain in place, and an omitted failed candidate is not
treated as withdrawn. Unknown, duplicate, cross-candidate, and passed targets
are never auto-mapped.

The runtime records separate format/contract/evidence repair counts and final
submit attempts so evaluation can compare delivery reliability and cost, not
only the number of fields in the final payload. Tool failures are likewise
classified: file-vs-directory and other bounded parameter/path errors are
recoverable with a corrective next step, while workspace/permission/policy
failures are not bypassable; repeated recoverable failures stop at the
configured bound.
