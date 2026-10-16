# ADR 0018 — Review Skill governance: approval, novelty, write gates and curation

Status: implemented on the product path. Quality gain from Skills remains unverified.
Baseline: main at `b344977` (PR #102).

## Context

Learned Skills entered the bank as soon as a learner returned a valid operation.
Run-derived experience became `trial` and trusted feedback became `active`
without a person seeing the text, although every later review in the same
repository could read it. Deduplication only caught byte-identical content, so
the same experience restated in other words accumulated as separate Skills.
Nothing used the per-run read records to find knowledge that no review needed.

Knowledge comes only from local reviews and local user feedback. External or
hub-installed Skills are out of scope, so this ADR adds no content-safety
scanner; that decision must be revisited before any external source is admitted.

## Decision

Govern Skills in three layers around one approval queue, following the
write-approval and curator ideas of Hermes Agent but keeping MergeWarden's
immutable, content-addressed bank.

```text
source ─▶ Layer 1: learner compares with every shown Skill ─▶ operations
        ─▶ Layer 2: normalize · exact/near-duplicate vs stored + pending ─▶ proposal (pending)
        ─▶ person: skills diff / approve / reject ─▶ published revision
run artifacts ─▶ usage projection ─▶ Layer 3: curate ─▶ retire proposals ─▶ same queue
```

### Write approval

- A learning result is validated and staged as a `Proposal` object referenced
  from the bank snapshot (`proposals`). It does not change `skills`, so
  `freezeSkills` and every review ignore it.
- `skills pending`, `skills diff --proposal`, `skills approve|reject --proposal ID|all [--note]`.
  The diff shows per-field changes, state and revision transitions, the
  learner's comparison and similarity warnings. Decisions record `by`, `at`
  and an optional note.
- Approval re-checks the live bank. A changed target revision, a withdrawn or
  superseded source, or a near-duplicate approved meanwhile marks the proposal
  `stale` and releases its learning job, which the next learning pass
  re-extracts against the current bank. Rejection is final for that job.
- Product paths use approval `required`. `ReviewOptions.skillApproval: 'auto'`
  and `learnPending({ approval: 'auto' })` exist for internal evaluation only;
  the engine refuses `auto` without `evaluation`. Auto decisions are recorded
  as `host_auto`.
- Direct human actions (`disable`, `rollback`, `pin`, `unpin`) stay immediate.

### Layer 1 — compare before extracting (`novelty-gated-1`)

Every non-noop operation carries `comparison`: exactly one entry per Skill in
the learning catalog the learner was shown, each `same | overlaps | distinct`
with a 1–600 character note naming the checking behaviour. The host rejects
incomplete or unknown entries, `add` when any entry is `same`, and
`revise | attach_source | retire` whose target is not compared as `same` or
`overlaps`. The check runs at the opaque-ref boundary (`identity.resolve`) and
again in the bank. This is a single model call: the host verifies completeness
and consistency, not the truth of each judgement.

### Layer 2 — write-time guarantees (`skill-similarity-1`)

- Content is normalized before validation, hashing and storage: NFC, collapsed
  whitespace, case-insensitive repeats removed, `./` and trailing `/` stripped
  from paths, canonical language names, dependencies sorted by path.
- Exact duplicates of any stored or pending Skill in the repository are refused.
- Near-duplicates are measured by Jaccard overlap of behaviour tokens (title,
  conditions, steps, counterexamples, stop conditions; Latin words and CJK
  bigrams). At or above 0.85 the write is refused and names the existing Skill;
  0.6–0.85 is staged with a warning for the approver. Retired Skills do not count.
- Layer 2 compares against the whole bank, including Skills the learner was not
  shown because of catalog limits, which Layer 1 cannot cover.

### Usage statistics (`skill-usage-1`)

Usage is recomputed from immutable run artifacts, never written during a review:
`run.json` `skills.available` gives catalog exposures, `skill-reads.json` gives
body reads (once per run). Current, non-withdrawn feedback on runs that read a
Skill is counted by relation as co-occurrence, not causation. `skills usage`
caches the index at `skills/usage.json`; the cache is never a review input.

### Layer 3 — curation (`skill-curation-1`)

`skills curate` considers learner-managed `trial`/`active` Skills that are not
pinned and have no pending proposal. A revision younger than 30 days is not
judged as unused.

| Finding | Rule | Action |
|---|---|---|
| unused | never listed by a review, revision ≥ 30 days old | retire |
| idle | last read ≥ 60 days ago | retire |
| unread | listed in ≥ 5 reviews, never read | review conditions |
| contradicted | ≥ 2 contradicting feedback on reading runs, more than supporting | review content |

Curation never edits knowledge. Without `--stage true` it only reports. With it,
retirements are staged as one proposal per repository in the approval queue and
the report is written under `skills/curation/`. Content changes are reported
only, because a rewrite needs a person or a learning source.

## Consequences

- No learned text reaches a review without a recorded human decision on the
  product path. Learning throughput now depends on someone reviewing proposals.
- Thresholds are policy constants with versions; they are initial values, not
  tuned on data. Near-duplicate detection is lexical and can miss paraphrases
  with little shared vocabulary; Layer 1 and the approver cover that gap.
- Usage counts exposures and reads, not whether a Skill improved a review.
  Proving quality gain still needs paired model replays.
- `eval/skills/offline.mjs` already failed on `b344977` because it emits raw
  operation IDs instead of opaque refs; this ADR does not change that.

## Not decided here

LLM consolidation of overlapping Skills, a content-safety scanner for external
Skills, and model-replay regression gates before activation.
