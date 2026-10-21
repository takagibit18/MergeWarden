# ADR 0020 — Accepted trade-offs and safety-fact investigation

Status: accepted. Implemented; effect on review quality not yet measured.
Baseline: `main` after PR #103 (ADR 0019).

## Context

Two review problems remain after ADR 0019.

1. **Repeat reports of accepted debt.** A developer explains once that a legacy or business
   pattern is a deliberate trade-off. Later reviews of the same module keep reporting the same
   risk. `SKILL_RULES` forbids suppressing a finding because a Skill says it is safe, so no
   Skill can stop the repetition. The noise costs human reviewers time and trust.
2. **Low cross-file recall.** The 36-sample blind review measured precision 87.5% and recall
   35.0%, and recall of untouched 1-hop cross-file defects was 12.5%
   ([IMPLEMENTATION_STATUS](../IMPLEMENTATION_STATUS.md)). The reviewer is quiet, not noisy.
   It rarely asks what the change's safety depends on outside the diff.

The design borrows two review practices. Adversarial-review triage keeps every dismissed
finding with a reason instead of deleting it, and a learned skip pattern always states when it
does **not** apply. Blast-radius analysis finds the one fact a change is safe because of and
proves it at the strongest affordable level.

## Decision

### Part A. Accepted trade-off Skills

1. **New Skill type `accepted_tradeoff`.** It is a `repository_fact` with non-empty `paths`.
   A `review_method` scope is refused, because a trade-off is about specific code, not a method.
2. **Only a human creates one.** The learner may produce `accepted_tradeoff` content only from a
   `local_user` feedback source with the new verdict `accepted_tradeoff`. Run-derived and
   simulated sources cannot create or revise it. Staging and `skills approve` follow ADR 0018.
   The feedback must carry a `--path/--start-line/--end-line` range. An approved accepted
   trade-off is `active`; it never passes through `trial`.
3. **Anchored to the accepted code, not to the file.** When the feedback is saved, the host
   records an anchor from the frozen head source: path, line count and the SHA-256 of the exact
   lines. The learner cannot set or change it. At review time the host searches the head file for
   the same lines, so the anchor survives edits elsewhere in the file and moved code. When the
   lines are not found, the Skill's freshness is `recheck` and it cannot fold anything. File-level
   `dependencies` play no part for this type.
4. **New SKILL.md section *Still report when*.** It maps to a new field `stillReportWhen` and is
   required (at least one item) for `accepted_tradeoff`. It names the conditions under which the
   same pattern is a real defect: new instances, changed contracts, data loss, security.
   Other Skill types may not use it.
5. **The model cites, the host decides.** A `submit_review` finding may carry
   `acceptedTradeoff: { skillId, note }`, where `note` says why no *Still report when* condition
   applies. The host folds the finding only when every deterministic gate passes:
   - the Skill is in this run's frozen package, has type `accepted_tradeoff` and state `active`;
   - its body was read in this run (`skill-reads.json`), so the model saw *Still report when*;
   - its anchor was found in this head snapshot (freshness `current`);
   - every evidence path lies inside the Skill's `paths` and is the anchor's file;
   - at least one head evidence ref exists, and every head evidence range lies inside the
     located anchor lines;
   - severity is `low` or `medium`.
6. **Nothing is dropped.** A folded finding moves from `findings` to a new report list
   `knownAccepted`, rendered as a collapsed **Known and accepted** section that names the Skill
   and revision. A finding whose citation fails a gate stays in `findings` with a one-line
   `acceptedTradeoffRejected` reason. The host decides at submission and records the decision on
   the accepted candidate, so recovery and replay rebuild the same report. A failed gate is not a submission error, so the model gains
   nothing by lowering severity to pass, and a mistaken citation never hides a finding.
7. **Hard rule for severe findings.** The severity gate in item 5 is the host's version of
   "security and data never auto-skip". `critical` and `high` findings are never folded, whatever the Skill says.
8. **`SKILL_RULES` changes from "never suppress" to "never remove".** A Skill still cannot
   establish a bug, safety, coverage or evidence. A cited, gated accepted trade-off may move a
   finding into *Known and accepted*. The policy versions change (`review-skills-3`,
   `skill-md-2`), so old runs replay with their frozen rules.

Report schema stays version 1. `knownAccepted` is optional and absent in old reports, so
existing hashes and readers are unaffected.

### Part B. Safety-fact investigation

9. **Prompt variant `investigation: safety_fact`, off by default.** It adds one instruction to
   the review prompt and to the `submit_review` summary contract. For each changed behavior,
   name the fact outside the diff that the change's safety depends on (for example "every
   caller passes a validated value"), check it with structural or text navigation and
   `read_source`, and state in the summary how far it was established: *stated*,
   *located at file:line*, or *traced along the failing path*. MergeWarden never executes
   reviewed code, so running it is out of scope.
10. **Eval before default.** The variant is selected by explicit CLI or eval configuration and
   recorded in the run manifest. It becomes the default only after a paired comparison on the
   existing real-PR corpus shows a recall gain without a precision loss.

## Rejected alternatives

- **Host fingerprint suppression.** It matches text, not meaning, and silently hides new
  instances. It stays as eval arm B only.
- **Confidence tiers (candidate, recurring, strong) before folding.** They fit learned skip
  patterns. Here the source is an explicit, approved human decision, and requiring repeats
  would defeat "explain once".
- **Full four-bucket report (act on, consider, noted, dismissed).** *Act on* is `findings`,
  *Noted* is `knownAccepted`, and *Dismissed* is already the summary's excluded concerns. A
  separate *Consider* list has no consumer yet.
- **Safety facts as a learned `review_method` Skill.** Skills are repository-scoped and fallible
  experience. A method that should apply to every review belongs in the versioned prompt.

## Validation

- Core tests for each fold gate, the hard severity rule, *Still report when* parsing, the
  human-only creation rule, report rendering and replay of a pre-ADR run.
- Accepted trade-off eval with probes P-repeat (folded), P-bug and P-new (still reported) and
  P-quiet, as recorded in the accepted trade-off eval plan.
- Paired real-PR runs for Part B before any default change.

## Consequences

- The report gains one optional section. Readers that ignore it see fewer main findings, and
  nothing disappears from the record.
- Parts A and B ship in one pull request; Part B stays off by default.
- Severity remains model-chosen, so a mis-graded severe defect could still be folded. The
  path scope, the read proof and *Still report when* limit this, and it is the residual risk.
